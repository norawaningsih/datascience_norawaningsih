"""Lightweight univariate LSTM implemented with NumPy for Vercel.

The implementation keeps the original RupiahCast workflow: Min-Max scaling,
sliding windows, holdout validation, recursive multi-step forecasting, and a
portable compressed NumPy checkpoint. It avoids the very large PyTorch wheel so
that the FastAPI bundle remains inside Vercel's function-size limit.
"""
from __future__ import annotations

import base64
import io
import json
import math
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

import numpy as np


@dataclass(frozen=True)
class Config:
    lookback: int = 30
    horizon: int = 14
    epochs: int = 20
    hidden_size: int = 32
    batch_size: int = 128
    learning_rate: float = 0.003
    validation_size: int = 30
    patience: int = 6
    seed: int = 42


class MinMaxScaler1D:
    def __init__(self) -> None:
        self.minimum = 0.0
        self.maximum = 1.0
        self.scale = 1.0

    def fit(self, values: np.ndarray) -> "MinMaxScaler1D":
        self.minimum = float(np.min(values))
        self.maximum = float(np.max(values))
        self.scale = self.maximum - self.minimum
        if not math.isfinite(self.scale) or self.scale <= 1e-12:
            raise ValueError("Nilai target konstan sehingga tidak dapat dilatih dengan LSTM.")
        return self

    def transform(self, values: np.ndarray) -> np.ndarray:
        return ((values - self.minimum) / self.scale).astype(np.float32)

    def inverse(self, values: np.ndarray) -> np.ndarray:
        return (values.astype(np.float64) * self.scale + self.minimum).astype(np.float64)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-x))


def make_sequences(values: np.ndarray, lookback: int, max_sequences: int = 1400) -> tuple[np.ndarray, np.ndarray]:
    count = len(values) - lookback
    if count <= 0:
        raise ValueError("Jumlah data harus lebih besar daripada lookback LSTM.")

    # Use recent and evenly spaced history to keep serverless training bounded.
    if count > max_sequences:
        recent_count = max_sequences // 2
        recent_start = count - recent_count
        older = np.linspace(0, recent_start - 1, max_sequences - recent_count, dtype=np.int64)
        recent = np.arange(recent_start, count, dtype=np.int64)
        indices = np.unique(np.concatenate([older, recent]))
    else:
        indices = np.arange(count, dtype=np.int64)

    x = np.empty((len(indices), lookback, 1), dtype=np.float32)
    y = np.empty((len(indices), 1), dtype=np.float32)
    for output_index, sequence_index in enumerate(indices):
        end = int(sequence_index) + lookback
        x[output_index, :, 0] = values[end - lookback:end]
        y[output_index, 0] = values[end]
    return x, y


class NumpyLSTMRegressor:
    """Single-layer LSTM with a linear regression head and Adam optimizer."""

    def __init__(self, hidden_size: int, seed: int) -> None:
        self.hidden_size = hidden_size
        rng = np.random.default_rng(seed)
        input_width = hidden_size + 1
        limit = math.sqrt(6.0 / (input_width + 4 * hidden_size))
        self.W = rng.uniform(-limit, limit, size=(input_width, 4 * hidden_size)).astype(np.float32)
        self.b = np.zeros((4 * hidden_size,), dtype=np.float32)
        # A positive forget-gate bias helps stable long-range learning.
        self.b[hidden_size:2 * hidden_size] = 1.0
        head_limit = math.sqrt(6.0 / (hidden_size + 1))
        self.Wy = rng.uniform(-head_limit, head_limit, size=(hidden_size, 1)).astype(np.float32)
        self.by = np.zeros((1,), dtype=np.float32)

        self._adam_m = {name: np.zeros_like(getattr(self, name)) for name in ("W", "b", "Wy", "by")}
        self._adam_v = {name: np.zeros_like(getattr(self, name)) for name in ("W", "b", "Wy", "by")}
        self._adam_step = 0

    def _forward(self, x: np.ndarray, keep_cache: bool) -> tuple[np.ndarray, Any]:
        batch_size, steps, _ = x.shape
        hidden = self.hidden_size
        h = np.zeros((batch_size, hidden), dtype=np.float32)
        c = np.zeros((batch_size, hidden), dtype=np.float32)
        cache: list[tuple[np.ndarray, ...]] = []

        for step in range(steps):
            x_t = x[:, step, :]
            concat = np.concatenate([x_t, h], axis=1)
            pre = concat @ self.W + self.b
            i = _sigmoid(pre[:, 0:hidden])
            f = _sigmoid(pre[:, hidden:2 * hidden])
            o = _sigmoid(pre[:, 2 * hidden:3 * hidden])
            g = np.tanh(pre[:, 3 * hidden:4 * hidden])
            c_prev = c
            h_prev = h
            c = f * c + i * g
            tanh_c = np.tanh(c)
            h = o * tanh_c
            if keep_cache:
                cache.append((concat, i, f, o, g, c_prev, c, tanh_c, h_prev))

        prediction = h @ self.Wy + self.by
        return prediction, (cache, h)

    def predict(self, x: np.ndarray) -> np.ndarray:
        prediction, _ = self._forward(x, keep_cache=False)
        return prediction

    def train_batch(self, x: np.ndarray, target: np.ndarray, learning_rate: float) -> float:
        prediction, (cache, final_h) = self._forward(x, keep_cache=True)
        batch_size = max(1, x.shape[0])
        error = prediction - target
        loss = float(np.mean(np.square(error)))

        dy = (2.0 / batch_size) * error
        grads: dict[str, np.ndarray] = {
            "Wy": final_h.T @ dy,
            "by": np.sum(dy, axis=0),
            "W": np.zeros_like(self.W),
            "b": np.zeros_like(self.b),
        }
        dh = dy @ self.Wy.T
        dc_next = np.zeros_like(dh)
        hidden = self.hidden_size

        for step_cache in reversed(cache):
            concat, i, f, o, g, c_prev, c, tanh_c, _h_prev = step_cache
            do = dh * tanh_c
            dc = dh * o * (1.0 - np.square(tanh_c)) + dc_next
            df = dc * c_prev
            di = dc * g
            dg = dc * i

            dpi = di * i * (1.0 - i)
            dpf = df * f * (1.0 - f)
            dpo = do * o * (1.0 - o)
            dpg = dg * (1.0 - np.square(g))
            dpre = np.concatenate([dpi, dpf, dpo, dpg], axis=1)

            grads["W"] += concat.T @ dpre
            grads["b"] += np.sum(dpre, axis=0)
            dconcat = dpre @ self.W.T
            dh = dconcat[:, 1:1 + hidden]
            dc_next = dc * f

        # Global norm clipping.
        total_norm = math.sqrt(sum(float(np.sum(np.square(grad))) for grad in grads.values()))
        if total_norm > 1.0:
            scale = 1.0 / (total_norm + 1e-8)
            for key in grads:
                grads[key] *= scale

        self._adam_step += 1
        beta1, beta2, epsilon = 0.9, 0.999, 1e-8
        for name, grad in grads.items():
            self._adam_m[name] = beta1 * self._adam_m[name] + (1.0 - beta1) * grad
            self._adam_v[name] = beta2 * self._adam_v[name] + (1.0 - beta2) * np.square(grad)
            m_hat = self._adam_m[name] / (1.0 - beta1 ** self._adam_step)
            v_hat = self._adam_v[name] / (1.0 - beta2 ** self._adam_step)
            parameter = getattr(self, name)
            parameter -= learning_rate * m_hat / (np.sqrt(v_hat) + epsilon)
        return loss

    def checkpoint_bytes(self, config: Config, scaler: MinMaxScaler1D, trained_rows: int) -> bytes:
        buffer = io.BytesIO()
        metadata = json.dumps(
            {
                "format": "rupiahcast-numpy-lstm-v1",
                "config": asdict(config),
                "scaler": {"minimum": scaler.minimum, "maximum": scaler.maximum},
                "trained_rows": trained_rows,
                "trained_at": datetime.now(timezone.utc).isoformat(),
            },
            ensure_ascii=False,
        )
        np.savez_compressed(
            buffer,
            W=self.W,
            b=self.b,
            Wy=self.Wy,
            by=self.by,
            metadata=np.asarray(metadata),
        )
        return buffer.getvalue()


def train_model(scaled_values: np.ndarray, config: Config, seed_offset: int = 0) -> tuple[NumpyLSTMRegressor, list[float], int]:
    x, y = make_sequences(scaled_values, config.lookback)
    rng = np.random.default_rng(config.seed + seed_offset)
    model = NumpyLSTMRegressor(config.hidden_size, config.seed + seed_offset)
    losses: list[float] = []
    best_loss = float("inf")
    best_weights: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None
    stale = 0

    for _epoch in range(config.epochs):
        indices = rng.permutation(len(x))
        running = 0.0
        samples = 0
        for start in range(0, len(indices), config.batch_size):
            batch_indices = indices[start:start + config.batch_size]
            batch_loss = model.train_batch(x[batch_indices], y[batch_indices], config.learning_rate)
            running += batch_loss * len(batch_indices)
            samples += len(batch_indices)
        epoch_loss = running / max(1, samples)
        losses.append(epoch_loss)
        if epoch_loss < best_loss - 1e-7:
            best_loss = epoch_loss
            best_weights = (model.W.copy(), model.b.copy(), model.Wy.copy(), model.by.copy())
            stale = 0
        else:
            stale += 1
            if stale >= config.patience:
                break

    if best_weights is not None:
        model.W, model.b, model.Wy, model.by = best_weights
    return model, losses, len(losses)


def recursive_forecast(model: NumpyLSTMRegressor, seed_window: np.ndarray, horizon: int) -> np.ndarray:
    working = [float(value) for value in seed_window.tolist()]
    predictions: list[float] = []
    lookback = len(seed_window)
    for _ in range(horizon):
        x = np.asarray(working[-lookback:], dtype=np.float32).reshape(1, lookback, 1)
        next_value = float(model.predict(x).reshape(-1)[0])
        next_value = max(-0.25, min(1.25, next_value))
        predictions.append(next_value)
        working.append(next_value)
    return np.asarray(predictions, dtype=np.float32)


def metrics(actual: np.ndarray, predicted: np.ndarray) -> tuple[dict[str, float], float]:
    errors = actual - predicted
    absolute = np.abs(errors)
    squared = np.square(errors)
    nonzero = np.abs(actual) > 1e-12
    percentage = np.abs(errors[nonzero] / actual[nonzero]) * 100.0
    values = {
        "mae": float(np.mean(absolute)),
        "rmse": float(np.sqrt(np.mean(squared))),
        "mape": float(np.mean(percentage)) if percentage.size else 0.0,
        "bias": float(np.mean(errors)),
    }
    residual_std = float(np.std(errors, ddof=1)) if len(errors) > 1 else 1.0
    return values, max(1.0, residual_std)


def next_business_dates(last_date: str, count: int) -> list[str]:
    try:
        current = datetime.strptime(last_date[:10], "%Y-%m-%d").date()
    except ValueError:
        current = date.today()
    output: list[str] = []
    while len(output) < count:
        current += timedelta(days=1)
        if current.weekday() < 5:
            output.append(current.isoformat())
    return output


def validate_payload(payload: dict[str, Any]) -> tuple[np.ndarray, str, Config]:
    raw_values = payload.get("values")
    if not isinstance(raw_values, list):
        raise ValueError("Payload values harus berupa array.")
    try:
        values = np.asarray([float(value) for value in raw_values], dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("Dataset berisi nilai target yang tidak numerik.") from exc
    if not np.all(np.isfinite(values)):
        raise ValueError("Dataset berisi nilai kosong, NaN, atau tak hingga.")

    requested = payload.get("parameters") if isinstance(payload.get("parameters"), dict) else {}
    lookback = max(5, min(120, int(requested.get("lookback", 30))))
    horizon = max(1, min(90, int(requested.get("horizon", 14))))
    epochs = max(3, min(50, int(requested.get("epochs", 20))))
    requested_hidden = int(requested.get("hidden_size", 32))
    # Keep compute predictable on 1-vCPU serverless instances.
    hidden_size = min((16, 24, 32, 48), key=lambda option: abs(option - min(requested_hidden, 48)))
    batch_size = max(16, min(256, int(requested.get("batch_size", 128))))
    learning_rate = max(0.0001, min(0.02, float(requested.get("learning_rate", 0.003))))
    validation_size = max(10, min(60, int(requested.get("validation_size", 30))))
    patience = max(2, min(12, int(requested.get("patience", 6))))
    seed = max(1, min(2_147_483_647, int(requested.get("seed", 42))))

    minimum_rows = lookback + validation_size + 20
    if len(values) < minimum_rows:
        raise ValueError(
            f"LSTM membutuhkan minimal {minimum_rows} observasi untuk lookback {lookback} "
            f"dan validasi {validation_size}."
        )

    last_date = str(payload.get("last_date") or date.today().isoformat())
    return values, last_date, Config(
        lookback=lookback,
        horizon=horizon,
        epochs=epochs,
        hidden_size=hidden_size,
        batch_size=batch_size,
        learning_rate=learning_rate,
        validation_size=validation_size,
        patience=patience,
        seed=seed,
    )


def run_forecast(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    values, last_date, config = validate_payload(payload)
    validation_size = min(config.validation_size, max(10, len(values) // 5))
    train_values = values[:-validation_size]
    validation_actual = values[-validation_size:]

    validation_scaler = MinMaxScaler1D().fit(train_values)
    scaled_train = validation_scaler.transform(train_values)
    validation_model, validation_losses, validation_epochs = train_model(scaled_train, config, 0)
    validation_scaled = recursive_forecast(validation_model, scaled_train[-config.lookback:], validation_size)
    validation_prediction = validation_scaler.inverse(validation_scaled)
    evaluation, residual_std = metrics(validation_actual, validation_prediction)

    final_scaler = MinMaxScaler1D().fit(values)
    scaled_full = final_scaler.transform(values)
    final_model, final_losses, final_epochs = train_model(scaled_full, config, 1000)
    forecast_scaled = recursive_forecast(final_model, scaled_full[-config.lookback:], config.horizon)
    forecast_values = final_scaler.inverse(forecast_scaled)

    lower: list[float] = []
    upper: list[float] = []
    for index, predicted in enumerate(forecast_values.tolist()):
        growth_factor = math.sqrt(1.0 + ((index + 1) * 0.08))
        margin = 1.96 * residual_std * growth_factor
        lower.append(max(0.0, float(predicted) - margin))
        upper.append(float(predicted) + margin)

    checkpoint = final_model.checkpoint_bytes(config, final_scaler, len(values))
    elapsed = time.perf_counter() - started
    return {
        "status": "ok",
        "model": "lstm",
        "label": "Long Short-Term Memory (NumPy)",
        "parameters": {
            "lookback": config.lookback,
            "epochs": config.epochs,
            "hidden_size": config.hidden_size,
            "requested_hidden_size": int((payload.get("parameters") or {}).get("hidden_size", config.hidden_size)),
            "num_layers": 1,
            "batch_size": config.batch_size,
            "learning_rate": config.learning_rate,
            "validation_size": validation_size,
            "seed": config.seed,
        },
        "metrics": evaluation,
        "residual_std": residual_std,
        "validation": {
            "actual": [float(value) for value in validation_actual.tolist()],
            "predicted": [float(value) for value in validation_prediction.tolist()],
        },
        "forecast": {
            "dates": next_business_dates(last_date, config.horizon),
            "values": [float(value) for value in forecast_values.tolist()],
            "lower": lower,
            "upper": upper,
        },
        "training": {
            "framework": "NumPy LSTM",
            "numpy_version": str(np.__version__),
            "device": "cpu",
            "validation_epochs_trained": validation_epochs,
            "final_epochs_trained": final_epochs,
            "validation_final_loss": float(validation_losses[-1]),
            "final_loss": float(final_losses[-1]),
            "seconds": round(elapsed, 3),
            "rows": int(len(values)),
        },
        "model_checkpoint": base64.b64encode(checkpoint).decode("ascii"),
        "model_extension": "npz",
    }
