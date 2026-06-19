(() => {
  'use strict';

  const APP_NAME = 'RupiahCast Pro LSTM';
  const APP_VERSION = '4.0.0';
  const STORAGE_KEY = 'rupiahcast-pro-lstm-v4';
  const FLASH_KEY = 'rupiahcast-flash-v4';
  const app = document.querySelector('#app');
  const flashStack = document.querySelector('[data-flash-stack]');
  let uploadPreview = null;
  let loadingTimer = null;

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const icon = (name, className = 'ui-icon') => `<svg class="${escapeHtml(className)}" aria-hidden="true" focusable="false"><use href="#icon-${escapeHtml(name)}"></use></svg>`;
  const uuid = (prefix) => `${prefix}_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
  const nowIso = () => new Date().toISOString();
  const params = () => new URLSearchParams(window.location.search);
  const pathName = () => window.location.pathname.split('/').pop() || 'index.php';

  const numberId = (value, decimals = 0) => Number(value || 0).toLocaleString('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const rupiahRate = (value, decimals = 0) => `Rp ${numberId(value, decimals)}`;
  const percentId = (value, decimals = 2) => `${Number(value) > 0 ? '+' : ''}${numberId(value, decimals)}%`;

  const dateId = (raw) => {
    if (!raw) return '-';
    const date = new Date(`${String(raw).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(date.getTime())) return String(raw);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    return `${String(date.getDate()).padStart(2, '0')} ${months[date.getMonth()]} ${date.getFullYear()}`;
  };

  const dateTimeId = (raw) => {
    if (!raw) return '-';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return String(raw);
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'Asia/Jakarta', hour12: false,
    }).format(date).replace('.', ':');
  };

  const modelLabel = (model) => ({
    sma: 'Simple Moving Average',
    wma: 'Weighted Moving Average',
    linear: 'Linear Trend',
    holt: 'Holt Double Exponential Smoothing',
    lstm: 'Long Short-Term Memory (NumPy)',
    auto: 'Model Otomatis',
  }[model] || 'Model Otomatis');

  const modelParameterText = (model, p = {}) => {
    if (['sma', 'wma', 'linear'].includes(model)) return `window ${Number(p.window || 14)} hari`;
    if (model === 'holt') return `α ${numberId(p.alpha || 0.30, 2)} · β ${numberId(p.beta || 0.10, 2)}`;
    if (model === 'lstm') return `lookback ${Number(p.lookback || 30)} · epoch ${Number(p.epochs || 20)} · hidden ${Number(p.hidden_size || 32)}`;
    return '-';
  };

  const setTitle = (title, activeNav) => {
    document.title = `${title} — ${APP_NAME}`;
    document.querySelectorAll('[data-nav]').forEach((link) => {
      link.classList.toggle('active', link.dataset.nav === activeNav);
    });
  };

  const navigate = (url) => { window.location.href = url; };

  const setFlash = (type, message) => {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ type, message }));
  };

  const renderFlash = () => {
    if (!flashStack) return;
    const raw = sessionStorage.getItem(FLASH_KEY);
    sessionStorage.removeItem(FLASH_KEY);
    if (!raw) { flashStack.innerHTML = ''; return; }
    try {
      const item = JSON.parse(raw);
      flashStack.innerHTML = `<div class="flash ${escapeHtml(item.type)}">${icon(item.type === 'success' ? 'check' : 'info', 'flash-icon')}<span>${escapeHtml(item.message)}</span><button type="button" data-dismiss aria-label="Tutup">×</button></div>`;
      flashStack.querySelector('[data-dismiss]')?.addEventListener('click', () => { flashStack.innerHTML = ''; });
    } catch { flashStack.innerHTML = ''; }
  };

  const loadState = async () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.version === 4) return parsed;
      } catch { localStorage.removeItem(STORAGE_KEY); }
    }
    const response = await fetch('/data/seed.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Data awal aplikasi tidak dapat dimuat.');
    const seed = await response.json();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  };

  let state;
  const saveState = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      throw new Error('Penyimpanan browser penuh. Hapus riwayat lama atau dataset yang tidak diperlukan.');
    }
  };

  const datasetById = (id) => state.datasets.find((item) => item.id === id) || null;
  const rowsById = (id) => [...(state.rows[id] || [])].sort((a, b) => a.date.localeCompare(b.date));
  const forecastById = (id) => state.forecasts.find((item) => item.id === id) || null;
  const sortedDatasets = () => [...state.datasets].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const sortedForecasts = () => [...state.forecasts].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const updateMetadata = (dataset) => {
    const rows = rowsById(dataset.id);
    dataset.row_count = rows.length;
    dataset.start_date = rows[0]?.date || null;
    dataset.end_date = rows.at(-1)?.date || null;
    dataset.updated_at = nowIso();
  };

  const normalizeDate = (raw) => {
    const value = String(raw || '').trim();
    let match = value.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)$/);
    if (match) {
      const output = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
      const parsed = new Date(`${output}T00:00:00`);
      return Number.isNaN(parsed.getTime()) ? null : output;
    }
    match = value.match(/^([0-3]?\d)[-\/]([01]?\d)[-\/](\d{4})$/);
    if (match) {
      const output = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      const parsed = new Date(`${output}T00:00:00`);
      return Number.isNaN(parsed.getTime()) ? null : output;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  };

  const normalizeNumber = (raw) => {
    let value = String(raw ?? '').trim().replace(/\s/g, '');
    if (!value) return null;
    if (value.includes(',') && value.includes('.')) {
      if (value.lastIndexOf(',') > value.lastIndexOf('.')) value = value.replaceAll('.', '').replace(',', '.');
      else value = value.replaceAll(',', '');
    } else if (value.includes(',')) {
      const parts = value.split(',');
      value = parts.length === 2 && parts[1].length <= 4 ? `${parts[0]}.${parts[1]}` : value.replaceAll(',', '');
    }
    const number = Number(value.replace(/[^0-9eE+\-.]/g, ''));
    return Number.isFinite(number) ? number : null;
  };

  const parseCsvLine = (line, delimiter) => {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        cells.push(cell.trim()); cell = '';
      } else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  };

  const parseCsv = (text) => {
    const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = clean.split('\n').filter((line) => line.trim() !== '');
    if (lines.length < 2) throw new Error('CSV harus memiliki header dan minimal satu baris data.');
    const candidates = [',', ';', '\t'];
    const delimiter = candidates.sort((a, b) => (lines[0].split(b).length - lines[0].split(a).length))[0];
    const headers = parseCsvLine(lines[0], delimiter).map((header) => header.trim());
    if (headers.length < 2) throw new Error('CSV harus memiliki minimal dua kolom.');
    const records = lines.slice(1).map((line) => {
      const cells = parseCsvLine(line, delimiter);
      return headers.map((_, index) => cells[index] ?? '');
    });
    return { headers, records };
  };

  const downloadBlob = (content, filename, type = 'text/csv;charset=utf-8') => {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const csvCell = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const mean = (values) => values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
  const standardDeviation = (values) => {
    if (values.length < 2) return 0;
    const average = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1));
  };

  const nextBusinessDates = (lastDate, count) => {
    const dates = [];
    const current = new Date(`${lastDate}T00:00:00`);
    while (dates.length < count) {
      current.setDate(current.getDate() + 1);
      const day = current.getDay();
      if (day !== 0 && day !== 6) dates.push(current.toISOString().slice(0, 10));
    }
    return dates;
  };

  const forecastValues = (inputSeries, model, parameters, horizon) => {
    const series = inputSeries.map(Number);
    if (model === 'sma') {
      const windowSize = Math.max(2, Math.min(Number(parameters.window || 14), series.length));
      const working = [...series]; const forecast = [];
      for (let step = 0; step < horizon; step += 1) {
        const next = mean(working.slice(-windowSize)); forecast.push(next); working.push(next);
      }
      return forecast;
    }
    if (model === 'wma') {
      const windowSize = Math.max(2, Math.min(Number(parameters.window || 14), series.length));
      const totalWeight = (windowSize * (windowSize + 1)) / 2;
      const working = [...series]; const forecast = [];
      for (let step = 0; step < horizon; step += 1) {
        const slice = working.slice(-windowSize);
        const next = slice.reduce((sum, value, index) => sum + value * (index + 1), 0) / totalWeight;
        forecast.push(next); working.push(next);
      }
      return forecast;
    }
    if (model === 'linear') {
      const windowSize = Math.max(5, Math.min(Number(parameters.window || 60), series.length));
      const slice = series.slice(-windowSize); const n = slice.length;
      let sumX = 0; let sumY = 0; let sumXY = 0; let sumXX = 0;
      slice.forEach((y, x) => { sumX += x; sumY += y; sumXY += x * y; sumXX += x * x; });
      const denominator = n * sumXX - sumX * sumX;
      const slope = Math.abs(denominator) < 1e-9 ? 0 : (n * sumXY - sumX * sumY) / denominator;
      const intercept = (sumY - slope * sumX) / n;
      return Array.from({ length: horizon }, (_, index) => Math.max(0, intercept + slope * ((n - 1) + index + 1)));
    }
    if (model === 'holt') {
      const alpha = Math.max(0.01, Math.min(0.99, Number(parameters.alpha || 0.30)));
      const beta = Math.max(0.01, Math.min(0.99, Number(parameters.beta || 0.10)));
      let level = series[0];
      const differences = [];
      for (let i = 1; i <= Math.min(5, series.length - 1); i += 1) differences.push(series[i] - series[i - 1]);
      let trend = mean(differences);
      for (let i = 1; i < series.length; i += 1) {
        const previousLevel = level;
        level = alpha * series[i] + (1 - alpha) * (level + trend);
        trend = beta * (level - previousLevel) + (1 - beta) * trend;
      }
      return Array.from({ length: horizon }, (_, index) => Math.max(0, level + (index + 1) * trend));
    }
    throw new Error('Model forecasting tidak didukung.');
  };

  const evaluateModel = (values, model, parameters, holdout = 30) => {
    const safeHoldout = Math.max(5, Math.min(holdout, values.length - 20));
    const train = values.slice(0, -safeHoldout);
    const actual = values.slice(-safeHoldout);
    const predicted = forecastValues(train, model, parameters, safeHoldout);
    const errors = actual.map((value, index) => value - predicted[index]);
    const absolute = errors.map(Math.abs);
    const squared = errors.map((value) => value ** 2);
    const percentage = errors.map((value, index) => Math.abs(actual[index]) > 1e-9 ? Math.abs(value / actual[index]) * 100 : 0);
    return {
      metrics: { mae: mean(absolute), rmse: Math.sqrt(mean(squared)), mape: mean(percentage), bias: mean(errors) },
      residual_std: Math.max(1, standardDeviation(errors)), actual, predicted,
    };
  };

  const selectBestModel = (values) => {
    const holdout = Math.max(10, Math.min(30, Math.floor(values.length / 4)));
    const candidates = [
      ['sma', 'Simple Moving Average (7)', { window: 7 }],
      ['sma', 'Simple Moving Average (14)', { window: 14 }],
      ['sma', 'Simple Moving Average (30)', { window: 30 }],
      ['wma', 'Weighted Moving Average (7)', { window: 7 }],
      ['wma', 'Weighted Moving Average (14)', { window: 14 }],
      ['linear', 'Linear Trend (30)', { window: 30 }],
      ['linear', 'Linear Trend (60)', { window: 60 }],
      ['linear', 'Linear Trend (120)', { window: 120 }],
      ['holt', 'Holt α0,20 β0,05', { alpha: 0.20, beta: 0.05 }],
      ['holt', 'Holt α0,30 β0,10', { alpha: 0.30, beta: 0.10 }],
      ['holt', 'Holt α0,50 β0,10', { alpha: 0.50, beta: 0.10 }],
      ['holt', 'Holt α0,60 β0,20', { alpha: 0.60, beta: 0.20 }],
    ].map(([model, label, parameters]) => {
      const evaluation = evaluateModel(values, model, parameters, holdout);
      return { model, label, parameters, ...evaluation, score: evaluation.metrics.rmse * (1 + evaluation.metrics.mape / 100) };
    }).sort((a, b) => a.score - b.score);
    return { ...candidates[0], candidates };
  };

  const makeForecast = (dates, values, selection, horizon) => {
    const predictions = forecastValues(values, selection.model, selection.parameters, horizon);
    const forecastDates = nextBusinessDates(dates.at(-1), horizon);
    const lower = []; const upper = [];
    predictions.forEach((value, index) => {
      const margin = 1.96 * Math.max(1, selection.residual_std) * Math.sqrt(1 + (index + 1) * 0.08);
      lower.push(Math.max(0, value - margin)); upper.push(value + margin);
    });
    return { dates: forecastDates, values: predictions, lower, upper };
  };

  const renderForecastChart = (actualValues, forecastValuesInput, lowerValues, upperValues, actualDates, forecastDates) => {
    if (!actualValues.length || !forecastValuesInput.length) return '<div class="empty-state">Data grafik belum tersedia.</div>';
    const width = 1120; const height = 420; const left = 78; const right = 26; const top = 28; const bottom = 58;
    const plotWidth = width - left - right; const plotHeight = height - top - bottom;
    const allValues = [...actualValues, ...lowerValues, ...upperValues];
    const minValue = Math.min(...allValues); const maxValue = Math.max(...allValues);
    const padding = Math.max(1, (maxValue - minValue) * 0.10);
    const minY = Math.max(0, minValue - padding); const maxY = maxValue + padding; const range = Math.max(1, maxY - minY);
    const allDates = [...actualDates, ...forecastDates]; const totalPoints = Math.max(2, allDates.length);
    const x = (index) => left + (index / (totalPoints - 1)) * plotWidth;
    const y = (value) => top + ((maxY - value) / range) * plotHeight;
    const points = (values, offset = 0) => values.map((value, index) => `${x(offset + index).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
    const actualCount = actualValues.length;
    const forecastPoints = `${x(actualCount - 1).toFixed(2)},${y(actualValues.at(-1)).toFixed(2)} ${points(forecastValuesInput, actualCount)}`;
    const bandTop = points(upperValues, actualCount);
    const bandBottom = [...lowerValues].reverse().map((value, reverseIndex) => {
      const index = lowerValues.length - 1 - reverseIndex;
      return `${x(actualCount + index).toFixed(2)},${y(value).toFixed(2)}`;
    }).join(' ');
    const ticks = Array.from({ length: 5 }, (_, tick) => {
      const tickValue = maxY - (range / 4) * tick; const tickY = top + (plotHeight / 4) * tick;
      return `<line x1="${left}" y1="${tickY.toFixed(2)}" x2="${width - right}" y2="${tickY.toFixed(2)}" class="chart-grid"/><text x="${left - 12}" y="${(tickY + 5).toFixed(2)}" text-anchor="end" class="chart-axis-label">${escapeHtml(numberId(tickValue, 0))}</text>`;
    }).join('');
    const labelIndexes = [...new Set([0, Math.floor((totalPoints - 1) / 2), totalPoints - 1])];
    const labels = labelIndexes.map((index) => `<text x="${x(index).toFixed(2)}" y="${height - 22}" text-anchor="${index === 0 ? 'start' : (index === totalPoints - 1 ? 'end' : 'middle')}" class="chart-axis-label">${escapeHtml(dateId(allDates[index] || ''))}</text>`).join('');
    return `<svg class="forecast-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Grafik data aktual dan hasil forecasting">${ticks}<line x1="${x(actualCount - 1).toFixed(2)}" y1="${top}" x2="${x(actualCount - 1).toFixed(2)}" y2="${height - bottom}" class="forecast-divider"/><text x="${(x(actualCount - 1) + 10).toFixed(2)}" y="${top + 16}" class="forecast-zone-label">FORECAST</text><polygon points="${bandTop} ${bandBottom}" class="confidence-band"/><polyline points="${points(actualValues)}" class="actual-line"/><polyline points="${forecastPoints}" class="forecast-line"/>${labels}<circle cx="${x(actualCount - 1).toFixed(2)}" cy="${y(actualValues.at(-1)).toFixed(2)}" r="5" class="actual-dot"/><circle cx="${x(totalPoints - 1).toFixed(2)}" cy="${y(forecastValuesInput.at(-1)).toFixed(2)}" r="6" class="forecast-dot"/></svg>`;
  };

  const datasetCard = (dataset, enhanced = false) => `<article class="dataset-card${enhanced ? ' enhanced-card' : ''}">
    <div class="dataset-card-top"><span class="file-icon">${enhanced ? `${icon('file', 'file-svg')}<b>CSV</b>` : 'CSV'}</span><span class="pill">${enhanced ? icon('rows', 'pill-icon') : ''} ${numberId(dataset.row_count)} baris</span></div>
    <h3>${escapeHtml(dataset.name)}</h3>
    <p>${enhanced ? 'Target:' : '<span class="muted">Kolom:</span> ' + escapeHtml(dataset.date_column) + ' →'} <strong>${escapeHtml(dataset.target_column)}</strong></p>
    <dl class="mini-details">
      <div><dt>${enhanced ? icon('clock', 'detail-icon') : ''} Periode</dt><dd>${escapeHtml(dateId(dataset.start_date))} – ${escapeHtml(dateId(dataset.end_date))}</dd></div>
      <div><dt>${enhanced ? icon('history', 'detail-icon') + ' Diperbarui' : 'Sumber'}</dt><dd>${enhanced ? escapeHtml(dateTimeId(dataset.updated_at)) : escapeHtml(dataset.original_filename || 'Data manual')}</dd></div>
    </dl>
    <div class="card-actions${enhanced ? '' : ' wrap'}">
      <a class="button small secondary" href="/dataset.php?id=${encodeURIComponent(dataset.id)}">${enhanced ? icon('edit') : ''} ${enhanced ? 'CRUD Data' : 'CRUD'}</a>
      <a class="button small primary" href="/forecast.php?id=${encodeURIComponent(dataset.id)}">${enhanced ? icon('play') : ''} Forecast</a>
      ${enhanced ? '' : `<button class="button small quiet" type="button" data-export-dataset="${escapeHtml(dataset.id)}">Export</button>`}
    </div>
  </article>`;

  const renderDashboard = () => {
    setTitle('Dashboard', 'dashboard');
    const datasets = sortedDatasets(); const forecasts = sortedForecasts();
    const totalRows = datasets.reduce((sum, dataset) => sum + Number(dataset.row_count || 0), 0);
    app.innerHTML = `<section class="hero compact-hero neural-hero">
      <div class="hero-grid-overlay" aria-hidden="true"></div>
      <div class="floating-currency currency-usd" aria-hidden="true"><span>$</span></div>
      <div class="floating-currency currency-idr" aria-hidden="true"><span>Rp</span></div>
      <div class="container hero-grid">
        <div class="hero-copy">
          <span class="eyebrow">${icon('sparkles', 'eyebrow-icon')} DEEP LEARNING EXCHANGE INTELLIGENCE</span>
          <h1 class="dashboard-hero-title">Forecasting Pergerakan <span class="currency-pair">USD/IDR</span> dengan <span class="model-name">Deep Learning LSTM</span></h1>
          <p>Kelola dataset kurs, latih jaringan saraf LSTM, bandingkan performa model, dan hasilkan proyeksi exchange rate dalam satu dashboard cerdas.</p>
          <div class="hero-badges" aria-label="Teknologi utama"><span>${icon('brain', 'badge-icon')} LSTM Neural Network</span><span>${icon('cpu', 'badge-icon')} Vercel Python Engine</span><span>${icon('chart', 'badge-icon')} Forecast Analytics</span></div>
          <div class="hero-actions"><a class="button light" href="/upload.php">${icon('upload')} Upload Dataset</a><a class="button ghost-light" href="/datasets.php">${icon('database')} Kelola Data</a></div>
        </div>
        <div class="currency-visual" aria-label="Visualisasi pertukaran USD ke IDR">
          <div class="orbit orbit-outer"><i></i><i></i><i></i></div><div class="orbit orbit-inner"></div>
          <div class="currency-coin coin-usd"><small>UNITED STATES</small><strong>$</strong><span>USD</span></div>
          <div class="exchange-core">${icon('exchange', 'exchange-core-icon')}<b></b><b></b><b></b></div>
          <div class="currency-coin coin-idr"><small>INDONESIA</small><strong>Rp</strong><span>IDR</span></div>
          <div class="market-mini-chart"><span>NEURAL SIGNAL</span><svg viewBox="0 0 180 52" aria-hidden="true"><defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fecaca" stop-opacity=".65"/><stop offset="1" stop-color="#fecaca" stop-opacity="0"/></linearGradient></defs><path class="spark-area" d="M2 45 L18 37 L31 40 L44 27 L57 31 L72 18 L86 22 L101 12 L117 19 L132 9 L148 13 L178 3 L178 52 L2 52 Z"/><path class="spark-line" pathLength="1" d="M2 45 L18 37 L31 40 L44 27 L57 31 L72 18 L86 22 L101 12 L117 19 L132 9 L148 13 L178 3"/><circle class="spark-dot" cx="178" cy="3" r="3.5"/></svg></div>
          <div class="neural-tag tag-one">${icon('brain', 'tag-icon')} LSTM</div><div class="neural-tag tag-two">${icon('chart', 'tag-icon')} Forecast</div>
        </div>
      </div>
    </section>
    <div class="container page-content dashboard-content">
      <section class="stats-grid four dashboard-stats">
        <article class="stat-card featured"><span class="stat-icon">${icon('database')}</span><div><span>Total dataset</span><strong>${datasets.length}</strong><small>siap dikelola</small></div></article>
        <article class="stat-card"><span class="stat-icon">${icon('rows')}</span><div><span>Total observasi</span><strong>${numberId(totalRows)}</strong><small>baris data</small></div></article>
        <article class="stat-card"><span class="stat-icon">${icon('history')}</span><div><span>Riwayat forecast</span><strong>${forecasts.length}</strong><small>hasil tersimpan</small></div></article>
        <article class="stat-card neural-stat"><span class="stat-icon">${icon('brain')}</span><div><span>Deep learning</span><strong>LSTM</strong><small>engine NumPy</small></div><i class="neural-pulse" aria-hidden="true"></i></article>
      </section>
      <div class="section-title-row"><div><span class="section-kicker">${icon('database', 'kicker-icon')} DATASET AKTIF</span><h2>Mulai dari data yang tersedia</h2></div><a class="button secondary" href="/upload.php">${icon('plus')} Upload CSV</a></div>
      ${datasets.length === 0 ? `<section class="empty-card"><div class="empty-icon">${icon('upload', 'empty-svg')}</div><h3>Belum ada dataset</h3><p>Upload CSV dengan kolom tanggal dan nilai kurs untuk memulai forecasting.</p><a class="button primary" href="/upload.php">${icon('upload')} Upload Dataset Pertama</a></section>` : `<section class="dataset-grid">${datasets.slice(0, 6).map((dataset) => datasetCard(dataset, true)).join('')}</section>`}
      <div class="section-title-row top-space"><div><span class="section-kicker">${icon('history', 'kicker-icon')} AKTIVITAS TERBARU</span><h2>Riwayat forecasting</h2></div><a class="text-link icon-link" href="/history.php">Lihat semua ${icon('arrow-right')}</a></div>
      <section class="table-card">${forecasts.length === 0 ? `<div class="table-empty">${icon('history', 'table-empty-icon')}<span>Belum ada hasil forecasting tersimpan.</span></div>` : `<div class="table-scroll"><table><thead><tr><th>Dataset</th><th>Model</th><th>Horizon</th><th>MAPE</th><th>Waktu</th><th></th></tr></thead><tbody>${forecasts.slice(0, 5).map((run) => `<tr><td><strong>${escapeHtml(run.dataset_name || '-')}</strong></td><td>${escapeHtml(run.selection?.label || modelLabel(run.model))}</td><td>${Number(run.horizon || 0)} hari</td><td>${numberId(run.metrics?.mape || 0, 2)}%</td><td>${escapeHtml(dateTimeId(run.created_at))}</td><td><a class="table-link icon-link" href="/forecast.php?id=${encodeURIComponent(run.dataset_id || '')}&run=${encodeURIComponent(run.id || '')}">Detail ${icon('arrow-right')}</a></td></tr>`).join('')}</tbody></table></div>`}</section>
    </div>`;
  };

  const renderDatasets = () => {
    setTitle('Dataset', 'datasets');
    const datasets = sortedDatasets();
    app.innerHTML = `<section class="page-hero"><div class="container page-hero-inner"><div><span class="eyebrow">DATA MANAGEMENT</span><h1>Daftar Dataset</h1><p>Pilih dataset untuk melihat, menambah, mengubah, menghapus, atau melakukan forecasting.</p></div><a class="button light" href="/upload.php">+ Upload CSV</a></div></section>
    <div class="container page-content standard-content">${datasets.length === 0 ? `<section class="empty-card"><div class="empty-icon">CSV</div><h3>Dataset belum tersedia</h3><p>Upload file CSV agar dapat dikelola dan diprediksi.</p><a class="button primary" href="/upload.php">Upload CSV</a></section>` : `<section class="dataset-grid">${datasets.map((dataset) => datasetCard(dataset)).join('')}</section>`}</div>`;
  };

  const renderDataset = () => {
    const id = params().get('id') || '';
    const dataset = datasetById(id);
    if (!dataset) { setFlash('error', 'Dataset tidak ditemukan.'); navigate('/datasets.php'); return; }
    setTitle(`CRUD ${dataset.name}`, 'datasets');
    const search = (params().get('q') || '').trim().toLowerCase();
    const allRows = rowsById(id);
    const filtered = search ? allRows.filter((row) => row.date.toLowerCase().includes(search) || String(row.value).toLowerCase().includes(search)) : allRows;
    const perPage = 25;
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
    const page = Math.max(1, Math.min(totalPages, Number(params().get('page') || 1)));
    const pageRows = filtered.slice((page - 1) * perPage, page * perPage);
    const query = encodeURIComponent(params().get('q') || '');
    app.innerHTML = `<section class="page-hero dataset-hero"><div class="container page-hero-inner"><div><span class="eyebrow">CRUD DATASET</span><h1>${escapeHtml(dataset.name)}</h1><p>${numberId(dataset.row_count)} observasi · ${escapeHtml(dateId(dataset.start_date))} sampai ${escapeHtml(dateId(dataset.end_date))}</p></div><div class="hero-actions"><a class="button light" href="/forecast.php?id=${encodeURIComponent(id)}">Jalankan Forecast</a><button class="button ghost-light" type="button" data-export-dataset="${escapeHtml(id)}">Export CSV</button></div></div></section>
    <div class="container page-content standard-content">
      <div class="management-grid">
        <section class="form-card compact-form-card"><div class="card-heading"><div><span class="section-kicker">CREATE</span><h2>Tambah Data</h2></div></div><form class="stack-form" data-dataset-action="add_row"><label><span>Tanggal</span><input type="date" name="date" required></label><label><span>Nilai ${escapeHtml(dataset.target_column)}</span><input type="number" name="value" min="0.00000001" step="any" required placeholder="Contoh: 16250"></label><button class="button primary wide" type="submit">+ Tambah Baris</button></form></section>
        <section class="form-card compact-form-card"><div class="card-heading"><div><span class="section-kicker">DATASET</span><h2>Pengaturan</h2></div></div><form class="stack-form" data-dataset-action="rename_dataset"><label><span>Nama dataset</span><input type="text" name="name" value="${escapeHtml(dataset.name)}" maxlength="100" required></label><button class="button secondary wide" type="submit">Simpan Nama</button></form><form data-dataset-action="delete_dataset" data-confirm="Dataset dan seluruh riwayat forecasting-nya akan dihapus permanen. Lanjutkan?" class="danger-zone-form"><button class="button danger-outline wide" type="submit">Hapus Dataset</button></form></section>
      </div>
      <section class="table-card data-table-card"><div class="card-heading responsive-heading"><div><span class="section-kicker">READ · UPDATE · DELETE</span><h2>Data Time Series</h2><p>${filtered.length} data ditemukan.</p></div><form class="search-form" method="get" action="/dataset.php"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="search" name="q" value="${escapeHtml(params().get('q') || '')}" placeholder="Cari tanggal atau nilai"><button class="button secondary small" type="submit">Cari</button>${search ? `<a class="text-link" href="/dataset.php?id=${encodeURIComponent(id)}">Reset</a>` : ''}</form></div>
      ${pageRows.length === 0 ? '<div class="table-empty">Tidak ada data yang cocok.</div>' : `<div class="table-scroll"><table class="crud-table"><thead><tr><th>ID</th><th>Tanggal</th><th>Nilai ${escapeHtml(dataset.target_column)}</th><th>Aksi</th></tr></thead><tbody>${pageRows.map((row) => `<tr><td class="row-id">#${Number(row.id)}</td><td colspan="3" class="inline-form-cell"><form class="inline-edit-form" data-dataset-action="update_row" data-row-id="${Number(row.id)}"><input type="date" name="date" value="${escapeHtml(row.date)}" required aria-label="Tanggal"><input type="number" name="value" value="${escapeHtml(row.value)}" step="any" min="0.00000001" required aria-label="Nilai"><button class="button tiny secondary" type="submit">Simpan</button></form><form class="inline-delete-form" data-dataset-action="delete_row" data-row-id="${Number(row.id)}" data-confirm="Hapus baris tanggal ${escapeHtml(row.date)}?"><button class="button tiny danger-outline" type="submit">Hapus</button></form></td></tr>`).join('')}</tbody></table></div>${totalPages > 1 ? `<nav class="pagination" aria-label="Navigasi halaman">${page > 1 ? `<a href="/dataset.php?id=${encodeURIComponent(id)}&q=${query}&page=${page - 1}">← Sebelumnya</a>` : ''}<span>Halaman ${page} dari ${totalPages}</span>${page < totalPages ? `<a href="/dataset.php?id=${encodeURIComponent(id)}&q=${query}&page=${page + 1}">Berikutnya →</a>` : ''}</nav>` : ''}`}</section>
    </div>`;
  };

  const uploadInitialMarkup = (error = '') => `<section class="page-hero"><div class="container page-hero-inner"><div><span class="eyebrow">IMPORT DATA</span><h1>Upload Dataset CSV</h1><p>Unggah file, pilih kolom tanggal dan target, lalu aplikasi akan menstandarkan data untuk CRUD dan forecasting.</p></div></div></section><div class="container page-content standard-content narrow-content">${error ? `<div class="inline-alert error"><strong>Upload belum berhasil.</strong><span>${escapeHtml(error)}</span></div>` : ''}<section class="form-card"><div class="step-heading"><span class="step-number">1</span><div><h2>Pilih file CSV</h2><p>Maksimal 10 MB. File perlu memiliki minimal satu kolom tanggal dan satu kolom nilai numerik.</p></div></div><form class="stack-form" data-upload-preview><label><span>Nama dataset</span><input type="text" name="name" maxlength="100" required placeholder="Contoh: Kurs USD/IDR Harian"></label><label class="upload-zone"><input type="file" name="csv_file" accept=".csv,.txt,text/csv" required data-file-input><span class="upload-icon">⇧</span><strong>Klik untuk memilih file</strong><small data-file-name>Belum ada file dipilih</small></label><button class="button primary wide" type="submit">Baca dan Preview CSV</button></form></section><section class="info-card"><h3>Format yang direkomendasikan</h3><pre>Date,USDIDR
2026-06-01,16280
2026-06-02,16295</pre><p>Format tanggal yang didukung: <code>YYYY-MM-DD</code>, <code>DD/MM/YYYY</code>, dan <code>DD-MM-YYYY</code>.</p></section></div>`;

  const renderUploadPreview = () => {
    const p = uploadPreview;
    app.innerHTML = `<section class="page-hero"><div class="container page-hero-inner"><div><span class="eyebrow">IMPORT DATA</span><h1>Upload Dataset CSV</h1><p>Unggah file, pilih kolom tanggal dan target, lalu aplikasi akan menstandarkan data untuk CRUD dan forecasting.</p></div></div></section><div class="container page-content standard-content narrow-content"><section class="form-card"><div class="step-heading"><span class="step-number">2</span><div><h2>Tentukan kolom forecasting</h2><p>File: <strong>${escapeHtml(p.original)}</strong></p></div></div><form class="stack-form" data-upload-import><div class="form-grid two"><label><span>Kolom tanggal</span><select name="date_column" required>${p.headers.map((header) => `<option value="${escapeHtml(header)}" ${header === p.dateGuess ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}</select></label><label><span>Kolom target/nilai kurs</span><select name="target_column" required>${p.headers.map((header) => `<option value="${escapeHtml(header)}" ${header === p.targetGuess ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}</select></label></div><div class="button-row"><button class="button secondary" type="button" data-upload-reset>Upload Ulang</button><button class="button primary" type="submit">Import Dataset</button></div></form></section><section class="table-card preview-card"><div class="card-heading"><div><span class="section-kicker">PREVIEW</span><h2>Contoh isi CSV</h2></div></div><div class="table-scroll"><table><thead><tr>${p.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${p.records.slice(0, 5).map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section></div>`;
    bindCommonEvents();
  };

  const renderUpload = () => {
    setTitle('Upload CSV', 'upload');
    uploadPreview = null;
    app.innerHTML = uploadInitialMarkup();
  };

  const loadingOverlayMarkup = () => `<div class="forecast-loading-overlay" data-forecast-loading hidden aria-hidden="true" aria-live="polite" aria-busy="true"><section class="forecast-loading-card" role="status" aria-label="Forecasting sedang diproses"><div class="ai-loader" aria-hidden="true"><span class="ai-loader-ring ring-one"></span><span class="ai-loader-ring ring-two"></span><span class="ai-loader-core">AI</span><i class="signal-dot dot-one"></i><i class="signal-dot dot-two"></i><i class="signal-dot dot-three"></i></div><span class="loading-kicker">RUPIAHCAST FORECAST ENGINE</span><h2 data-loading-title>Menyiapkan proses forecasting</h2><p class="loading-message" data-loading-message>Memvalidasi dataset dan parameter yang dipilih...</p><div class="loading-track" aria-hidden="true"><span></span></div><div class="loading-summary"><div><span>Model</span><strong data-loading-model>—</strong></div><div><span>Konfigurasi</span><strong data-loading-config>—</strong></div><div><span>Waktu berjalan</span><strong data-loading-time>00:00</strong></div></div><div class="loading-pulse-row" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><p class="loading-note"><strong>Proses sedang berjalan.</strong> Jangan menutup, me-refresh, atau kembali dari halaman ini sampai hasil ditampilkan.</p></section></div>`;

  const forecastResultMarkup = (run) => {
    if (!run) return '<section class="empty-card result-empty"><div class="empty-icon">↗</div><h3>Belum ada hasil yang ditampilkan</h3><p>Pilih “LSTM — Deep Learning” untuk melatih model LSTM dari dataset aktif.</p></section>';
    const forecastData = run.forecast || { dates: [], values: [], lower: [], upper: [] };
    const metrics = run.metrics || {};
    const isUp = Number(run.change_percent || 0) >= 0;
    const isLstm = run.model === 'lstm';
    const training = run.training || {};
    const frameworkVersion = training.torch_version || training.numpy_version || '';
    return `<section class="result-header"><div><span class="section-kicker">${isLstm ? 'HASIL DEEP LEARNING' : 'HASIL TERSIMPAN'}</span><h2>${escapeHtml(run.selection?.label || modelLabel(run.model))}</h2><p>${escapeHtml(dateTimeId(run.created_at))} · ${escapeHtml(modelParameterText(run.model, run.selection?.parameters || {}))}</p></div><div class="button-row"><button class="button secondary" type="button" data-export-forecast="${escapeHtml(run.id)}">Download Hasil CSV</button>${isLstm && run.model_checkpoint ? `<button class="button secondary" type="button" data-export-model="${escapeHtml(run.id)}">Download Model .${escapeHtml(run.model_extension || 'npz')}</button>` : ''}<a class="button quiet" href="/history.php">Riwayat</a></div></section>
    <section class="stats-grid four"><article class="stat-card featured"><span>Nilai terakhir</span><strong>${escapeHtml(rupiahRate(run.last_actual, 2))}</strong><small>${escapeHtml(dateId(run.last_date))}</small></article><article class="stat-card"><span>Prediksi akhir</span><strong>${escapeHtml(rupiahRate(run.end_forecast, 2))}</strong><small>${escapeHtml(dateId(forecastData.dates.at(-1)))}</small></article><article class="stat-card"><span>Perubahan</span><strong class="${isUp ? 'negative-value' : 'positive-value'}">${escapeHtml(percentId(run.change_percent, 2))}</strong><small>${escapeHtml(run.trend_label)}</small></article><article class="stat-card"><span>MAPE validasi</span><strong>${escapeHtml(numberId(metrics.mape || 0, 2))}%</strong><small>${isLstm ? 'holdout 30 data' : 'akurasi historis'}</small></article></section>
    <section class="chart-card"><div class="card-heading responsive-heading"><div><span class="section-kicker">VISUALISASI</span><h2>Aktual dan Forecast</h2></div><div class="chart-legend"><span><i class="legend actual"></i>Aktual</span><span><i class="legend predicted"></i>Prediksi</span><span><i class="legend band"></i>Interval 95%</span></div></div><div class="chart-scroll">${renderForecastChart(run.history_values || [], forecastData.values || [], forecastData.lower || [], forecastData.upper || [], run.history_dates || [], forecastData.dates || [])}</div><p class="chart-note">Forecast LSTM bersifat recursive multi-step. Tanggal melewati Sabtu dan Minggu; hari libur nasional belum dikecualikan.</p></section>
    <div class="result-grid"><section class="metric-card"><div class="card-heading"><div><span class="section-kicker">EVALUASI</span><h2>Metrik Model</h2></div></div><div class="metric-list"><div><span>MAE</span><strong>${numberId(metrics.mae || 0, 2)}</strong></div><div><span>RMSE</span><strong>${numberId(metrics.rmse || 0, 2)}</strong></div><div><span>MAPE</span><strong>${numberId(metrics.mape || 0, 2)}%</strong></div><div><span>Bias</span><strong>${numberId(metrics.bias || 0, 2)}</strong></div></div></section><section class="metric-card"><div class="card-heading"><div><span class="section-kicker">MODEL</span><h2>${escapeHtml(run.selection?.label || modelLabel(run.model))}</h2></div></div><p>${isLstm ? 'Data dinormalisasi dengan Min–Max, dibentuk menjadi sliding window, diuji pada holdout, lalu model akhir dilatih menggunakan seluruh data.' : 'Model divalidasi menggunakan bagian akhir data historis. MAPE yang lebih kecil menunjukkan kesalahan persentase rata-rata yang lebih rendah.'}</p><div class="model-code-row"><span>${escapeHtml(String(run.model).toUpperCase())}</span><strong>${escapeHtml(modelParameterText(run.model, run.selection?.parameters || {}))}</strong></div></section></div>
    ${isLstm ? `<section class="metric-card training-card"><div class="card-heading responsive-heading"><div><span class="section-kicker">TRAINING LSTM</span><h2>Informasi Pelatihan</h2><p>Checkpoint model tersedia untuk diunduh setelah proses training.</p></div><span class="ai-badge">NEURAL NETWORK</span></div><div class="training-grid"><div><span>Framework</span><strong>${escapeHtml(training.framework || 'LSTM')} ${escapeHtml(frameworkVersion)}</strong></div><div><span>Epoch final</span><strong>${Number(training.final_epochs_trained || 0)}</strong></div><div><span>Final loss</span><strong>${numberId(training.final_loss || 0, 7)}</strong></div><div><span>Waktu training</span><strong>${numberId(training.seconds || 0, 2)} detik</strong></div><div><span>Data training</span><strong>${numberId(training.rows || 0)} baris</strong></div><div><span>Device</span><strong>${escapeHtml(String(training.device || 'cpu').toUpperCase())}</strong></div></div></section>` : ''}
    <section class="table-card forecast-table-card"><div class="card-heading"><div><span class="section-kicker">OUTPUT</span><h2>Tabel Prediksi</h2></div></div><div class="table-scroll"><table><thead><tr><th>No.</th><th>Tanggal</th><th>Prediksi</th><th>Batas Bawah 95%</th><th>Batas Atas 95%</th></tr></thead><tbody>${(forecastData.dates || []).map((date, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(dateId(date))}</td><td><strong>${escapeHtml(rupiahRate(forecastData.values[index], 2))}</strong></td><td>${escapeHtml(rupiahRate(forecastData.lower[index], 2))}</td><td>${escapeHtml(rupiahRate(forecastData.upper[index], 2))}</td></tr>`).join('')}</tbody></table></div></section>`;
  };

  const renderForecast = () => {
    const id = params().get('id') || '';
    const dataset = datasetById(id);
    if (!dataset) { setFlash('error', 'Dataset tidak ditemukan.'); navigate('/datasets.php'); return; }
    const requestedRun = params().get('run');
    const run = requestedRun ? forecastById(requestedRun) : null;
    if (requestedRun && (!run || run.dataset_id !== id)) { setFlash('error', 'Hasil forecasting tidak ditemukan untuk dataset ini.'); navigate(`/forecast.php?id=${encodeURIComponent(id)}`); return; }
    setTitle(`Forecast ${dataset.name}`, 'datasets');
    app.innerHTML = `<section class="page-hero forecast-hero"><div class="container page-hero-inner"><div><span class="eyebrow">STATISTICAL + DEEP LEARNING</span><h1>${escapeHtml(dataset.name)}</h1><p>Target ${escapeHtml(dataset.target_column)} · ${numberId(dataset.row_count)} observasi · tersedia model statistik dan LSTM.</p></div><a class="button ghost-light" href="/dataset.php?id=${encodeURIComponent(id)}">← Kembali ke CRUD</a></div></section>
    <div class="container page-content standard-content"><section class="form-card forecast-control-card"><div class="card-heading responsive-heading"><div><span class="section-kicker">KONFIGURASI</span><h2>Jalankan Forecasting</h2><p>Mode LSTM akan melatih jaringan saraf melalui Vercel Python Function dan menyiapkan checkpoint model.</p></div><a class="text-link" href="/lstm_setup.php">Cek engine LSTM →</a></div><form class="forecast-form advanced" data-forecast-form><label><span>Model</span><select name="model" data-model-select><option value="auto">Otomatis — model statistik terbaik</option><option value="sma">Simple Moving Average</option><option value="wma">Weighted Moving Average</option><option value="linear">Linear Trend</option><option value="holt">Holt Exponential Smoothing</option><option value="lstm">LSTM — Deep Learning</option></select></label><label><span data-window-label>Window / lookback</span><select name="window">${[7, 14, 30, 60, 120].map((option) => `<option value="${option}" ${option === 30 ? 'selected' : ''}>${option} data</option>`).join('')}</select></label><label><span>Horizon</span><select name="horizon">${[7, 14, 30, 60, 90].map((option) => `<option value="${option}" ${option === 14 ? 'selected' : ''}>${option} hari kerja</option>`).join('')}</select></label><label data-lstm-field><span>Epoch LSTM</span><select name="epochs">${[5, 10, 20, 30, 50].map((option) => `<option value="${option}" ${option === 20 ? 'selected' : ''}>${option} epoch</option>`).join('')}</select></label><label data-lstm-field><span>Hidden units</span><select name="hidden_size">${[16, 32, 64, 128].map((option) => `<option value="${option}" ${option === 32 ? 'selected' : ''}>${option} unit</option>`).join('')}</select></label><button class="button primary forecast-submit-button" type="submit" data-forecast-submit><span data-submit-label>Jalankan &amp; Simpan</span></button></form>${Number(dataset.row_count) < 30 ? `<div class="inline-alert warning"><strong>Data belum cukup.</strong><span>Tambahkan sedikitnya ${30 - Number(dataset.row_count)} observasi lagi agar forecasting statistik dapat dijalankan.</span></div>` : ''}</section>${forecastResultMarkup(run)}</div>${loadingOverlayMarkup()}`;
  };

  const renderHistory = () => {
    setTitle('Riwayat Forecast', 'history');
    const runs = sortedForecasts();
    app.innerHTML = `<section class="page-hero"><div class="container page-hero-inner"><div><span class="eyebrow">FORECAST ARCHIVE</span><h1>Riwayat Forecasting</h1><p>Semua hasil forecasting yang pernah dijalankan tersimpan dan dapat dibuka, diekspor, atau dihapus.</p></div></div></section><div class="container page-content standard-content"><section class="table-card"><div class="card-heading"><div><span class="section-kicker">TERSIMPAN</span><h2>${runs.length} Hasil Forecast</h2></div></div>${runs.length === 0 ? '<div class="table-empty">Belum ada riwayat forecasting.</div>' : `<div class="table-scroll"><table><thead><tr><th>Dataset</th><th>Model</th><th>Horizon</th><th>Forecast Akhir</th><th>MAPE</th><th>Dibuat</th><th>Aksi</th></tr></thead><tbody>${runs.map((run) => `<tr><td><strong>${escapeHtml(run.dataset_name || '-')}</strong><small class="table-subtext">${escapeHtml(run.target_column || '')}</small></td><td>${escapeHtml(run.selection?.label || modelLabel(run.model))}</td><td>${Number(run.horizon || 0)} hari</td><td>${escapeHtml(rupiahRate(run.end_forecast || 0, 2))}</td><td>${escapeHtml(numberId(run.metrics?.mape || 0, 2))}%</td><td>${escapeHtml(dateTimeId(run.created_at))}</td><td><div class="table-actions"><a class="button tiny secondary" href="/forecast.php?id=${encodeURIComponent(run.dataset_id || '')}&run=${encodeURIComponent(run.id || '')}">Detail</a><button class="button tiny quiet" type="button" data-export-forecast="${escapeHtml(run.id)}">CSV</button><form data-delete-run="${escapeHtml(run.id)}" data-confirm="Hapus hasil forecasting ini?"><button class="button tiny danger-outline" type="submit">Hapus</button></form></div></td></tr>`).join('')}</tbody></table></div>`}</section></div>`;
  };

  const renderLstmSetup = async () => {
    setTitle('Setup LSTM', 'lstm');
    let diagnostics = { status: 'error', message: 'Engine belum diperiksa.', checks: {} };
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      diagnostics = await response.json();
      if (!response.ok) throw new Error(diagnostics.detail || 'Health check gagal.');
    } catch (error) {
      diagnostics = { status: 'error', message: error.message, checks: {} };
    }
    const checks = diagnostics.checks || {};
    const ready = diagnostics.status === 'ok' && checks.lstm_available;
    app.innerHTML = `<section class="page-hero"><div class="container page-hero-inner"><div><span class="eyebrow">VERCEL PYTHON ENGINE</span><h1>Setup dan Diagnostik LSTM</h1><p>Halaman ini memeriksa FastAPI, Python, NumPy, dan kesiapan engine LSTM pada Vercel.</p></div><a class="button ghost-light" href="/datasets.php">Pilih Dataset →</a></div></section><div class="container page-content standard-content"><section class="status-panel ${ready ? 'ready' : 'not-ready'}"><div class="status-icon">${ready ? '✓' : '!'}</div><div><span class="section-kicker">STATUS ENGINE</span><h2>${ready ? 'LSTM siap digunakan' : 'LSTM belum siap'}</h2><p>${ready ? 'FastAPI dan engine NumPy LSTM berhasil dijalankan.' : escapeHtml(diagnostics.message || 'Periksa deployment Vercel.')}</p></div></section><div class="result-grid"><section class="info-card"><div class="card-heading"><div><span class="section-kicker">DIAGNOSTIK</span><h2>Lingkungan Sistem</h2></div></div><div class="metric-list setup-metrics"><div><span>Runtime</span><strong>${escapeHtml(checks.runtime || '-')}</strong></div><div><span>Python</span><strong>${escapeHtml(checks.python_version || '-')}</strong></div><div><span>NumPy</span><strong>${escapeHtml(checks.numpy_version || '-')}</strong></div><div><span>Penyimpanan</span><strong>${escapeHtml(checks.storage || 'Browser localStorage')}</strong></div></div><p>Endpoint engine: <code>/api/lstm</code></p></section><section class="info-card"><div class="card-heading"><div><span class="section-kicker">ARSITEKTUR</span><h2>LSTM yang Digunakan</h2></div></div><ul class="feature-list"><li>Univariate LSTM dengan input satu target kurs.</li><li>Normalisasi Min–Max dan sliding window.</li><li>Holdout validation untuk MAE, RMSE, MAPE, dan bias.</li><li>Recursive multi-step forecasting hingga 90 hari kerja.</li><li>Checkpoint model berformat <code>.npz</code>.</li></ul></section></div><section class="info-card install-card"><div class="card-heading"><div><span class="section-kicker">DEPLOYMENT VERCEL</span><h2>Arsitektur tanpa XAMPP</h2></div></div><ol class="install-steps"><li>Frontend berjalan sebagai aplikasi web responsif dengan tampilan yang sama.</li><li>Dataset, CRUD, dan riwayat disimpan pada browser pengguna.</li><li>Training LSTM diproses oleh FastAPI Vercel Function.</li><li>Tidak diperlukan <code>proc_open</code>, PHP, XAMPP, atau folder storage yang dapat ditulis.</li></ol></section><section class="info-card install-card"><div class="card-heading"><div><span class="section-kicker">CATATAN PENYIMPANAN</span><h2>Data mengikuti browser</h2></div></div><p>Dataset dan riwayat tersimpan pada <code>localStorage</code>. Data tetap ada saat halaman dimuat ulang pada browser yang sama, tetapi tidak otomatis tersinkron ke perangkat lain.</p></section></div>`;
  };

  const renderNotFound = () => {
    setTitle('Halaman Tidak Ditemukan', '');
    app.innerHTML = '<div class="container page-content standard-content"><section class="empty-card"><h3>Halaman tidak ditemukan</h3><p>Kembali ke dashboard untuk melanjutkan.</p><a class="button primary" href="/index.php">Dashboard</a></section></div>';
  };

  const enrichActionIcons = () => {
    const rules = [['kembali', 'arrow-left'], ['hapus', 'trash'], ['simpan', 'save'], ['import', 'save'], ['cari', 'search'], ['download', 'download'], ['export', 'download'], ['upload', 'upload'], ['tambah', 'plus'], ['jalankan', 'play'], ['forecast', 'chart'], ['crud', 'edit'], ['kelola', 'database'], ['riwayat', 'history'], ['preview', 'file'], ['baca', 'file'], ['pilih dataset', 'database'], ['csv', 'file'], ['detail', 'arrow-right']];
    document.querySelectorAll('.button, .table-link').forEach((action) => {
      if (action.querySelector('.ui-icon') || action.hasAttribute('data-no-icon')) return;
      const text = (action.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const match = rules.find(([keyword]) => text.includes(keyword));
      if (!match) return;
      action.insertAdjacentHTML('afterbegin', icon(match[1]));
      action.classList.add('icon-decorated');
    });
  };

  const exportDataset = (id) => {
    const dataset = datasetById(id); if (!dataset) return;
    const rows = rowsById(id);
    const csv = `\uFEFF${[dataset.date_column, dataset.target_column].map(csvCell).join(',')}\n${rows.map((row) => [row.date, row.value].map(csvCell).join(',')).join('\n')}\n`;
    const slug = dataset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dataset';
    downloadBlob(csv, `dataset-${slug}.csv`);
  };

  const exportForecast = (id) => {
    const run = forecastById(id); if (!run) return;
    const rows = [
      ['Dataset', run.dataset_name || ''], ['Target', run.target_column || ''], ['Model', run.selection?.label || ''], ['Horizon', run.horizon || 0], ['MAPE', run.metrics?.mape || 0], [], ['No', 'Date', 'Forecast', 'Lower_95', 'Upper_95'],
    ];
    (run.forecast?.dates || []).forEach((date, index) => rows.push([index + 1, date, run.forecast.values[index], run.forecast.lower[index], run.forecast.upper[index]]));
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
    const slug = String(run.dataset_name || 'dataset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    downloadBlob(csv, `forecast-${slug}-${id}.csv`);
  };

  const exportModel = (id) => {
    const run = forecastById(id);
    if (!run?.model_checkpoint) { window.alert('Checkpoint model tidak tersedia untuk hasil ini.'); return; }
    const binary = atob(run.model_checkpoint);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const extension = run.model_extension || 'npz';
    downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `lstm-${id}.${extension}`, 'application/octet-stream');
  };

  const handleDatasetAction = (form) => {
    const id = params().get('id') || '';
    const dataset = datasetById(id);
    if (!dataset) throw new Error('Dataset tidak ditemukan.');
    const action = form.dataset.datasetAction;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;
    const data = new FormData(form);
    const rows = state.rows[id] || [];

    if (action === 'add_row') {
      const date = normalizeDate(data.get('date')); const value = Number(data.get('value'));
      if (!date || !Number.isFinite(value) || value <= 0) throw new Error('Tanggal dan nilai harus valid.');
      if (rows.some((row) => row.date === date)) throw new Error('Tanggal tersebut sudah ada pada dataset.');
      const nextId = Number(dataset.next_row_id || Math.max(0, ...rows.map((row) => Number(row.id))) + 1);
      rows.push({ id: nextId, date, value }); dataset.next_row_id = nextId + 1;
      setFlash('success', 'Baris data berhasil ditambahkan.');
    } else if (action === 'update_row') {
      const rowId = Number(form.dataset.rowId); const date = normalizeDate(data.get('date')); const value = Number(data.get('value'));
      if (!date || !Number.isFinite(value) || value <= 0) throw new Error('Tanggal dan nilai harus valid.');
      if (rows.some((row) => Number(row.id) !== rowId && row.date === date)) throw new Error('Tanggal tersebut sudah digunakan oleh baris lain.');
      const row = rows.find((item) => Number(item.id) === rowId); if (!row) throw new Error('Baris data tidak ditemukan.');
      row.date = date; row.value = value; setFlash('success', 'Baris data berhasil diperbarui.');
    } else if (action === 'delete_row') {
      const rowId = Number(form.dataset.rowId); const index = rows.findIndex((item) => Number(item.id) === rowId);
      if (index < 0) throw new Error('Baris data tidak ditemukan.');
      rows.splice(index, 1); setFlash('success', 'Baris data berhasil dihapus.');
    } else if (action === 'rename_dataset') {
      const name = String(data.get('name') || '').trim();
      if (!name || name.length > 100) throw new Error('Nama dataset wajib diisi dan maksimal 100 karakter.');
      dataset.name = name; setFlash('success', 'Nama dataset berhasil diperbarui.');
    } else if (action === 'delete_dataset') {
      state.datasets = state.datasets.filter((item) => item.id !== id); delete state.rows[id];
      state.forecasts = state.forecasts.filter((run) => run.dataset_id !== id); saveState();
      setFlash('success', 'Dataset beserta riwayat forecasting berhasil dihapus.'); navigate('/datasets.php'); return;
    }
    state.rows[id] = rows.sort((a, b) => a.date.localeCompare(b.date)); updateMetadata(dataset); saveState(); navigate(window.location.href);
  };

  const bindUploadEvents = () => {
    const fileInput = document.querySelector('[data-file-input]');
    const fileName = document.querySelector('[data-file-name]');
    fileInput?.addEventListener('change', () => { if (fileName) fileName.textContent = fileInput.files?.[0]?.name || 'Belum ada file dipilih'; });

    document.querySelector('[data-upload-preview]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget; const data = new FormData(form);
      try {
        const name = String(data.get('name') || '').trim(); const file = data.get('csv_file');
        if (!name || name.length > 100) throw new Error('Nama dataset wajib diisi dan maksimal 100 karakter.');
        if (!(file instanceof File) || file.size <= 0) throw new Error('Pilih file CSV terlebih dahulu.');
        if (file.size > 10 * 1024 * 1024) throw new Error('Ukuran file maksimal 10 MB.');
        if (!/\.(csv|txt)$/i.test(file.name)) throw new Error('Format file harus CSV atau TXT berformat tabel.');
        const parsed = parseCsv(await file.text());
        const dateGuess = parsed.headers.includes('Date') ? 'Date' : parsed.headers[0];
        const targetGuess = parsed.headers.includes('USDIDR') ? 'USDIDR' : parsed.headers[1];
        uploadPreview = { name, original: file.name, ...parsed, dateGuess, targetGuess };
        renderUploadPreview();
      } catch (error) { app.innerHTML = uploadInitialMarkup(error.message); bindCommonEvents(); }
    });

    document.querySelector('[data-upload-reset]')?.addEventListener('click', () => { uploadPreview = null; renderUpload(); bindCommonEvents(); });
    document.querySelector('[data-upload-import]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        if (!uploadPreview) throw new Error('Sesi preview sudah berakhir. Upload ulang file CSV.');
        const data = new FormData(event.currentTarget);
        const dateColumn = String(data.get('date_column') || ''); const targetColumn = String(data.get('target_column') || '');
        const dateIndex = uploadPreview.headers.indexOf(dateColumn); const targetIndex = uploadPreview.headers.indexOf(targetColumn);
        if (dateIndex < 0 || targetIndex < 0) throw new Error('Kolom tanggal atau target tidak ditemukan.');
        const byDate = new Map(); let skipped = 0; let duplicates = 0;
        uploadPreview.records.forEach((record) => {
          const date = normalizeDate(record[dateIndex]); const value = normalizeNumber(record[targetIndex]);
          if (!date || value === null || !Number.isFinite(value) || value <= 0) { skipped += 1; return; }
          if (byDate.has(date)) duplicates += 1; byDate.set(date, value);
        });
        const entries = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        if (entries.length < 10) throw new Error('Dataset harus memiliki minimal 10 baris tanggal dan nilai valid.');
        const id = uuid('ds'); const rows = entries.map(([date, value], index) => ({ id: index + 1, date, value })); const timestamp = nowIso();
        const dataset = { id, name: uploadPreview.name, date_column: dateColumn, target_column: targetColumn, original_filename: uploadPreview.original, row_count: rows.length, start_date: rows[0].date, end_date: rows.at(-1).date, next_row_id: rows.length + 1, created_at: timestamp, updated_at: timestamp };
        state.datasets.push(dataset); state.rows[id] = rows; saveState();
        setFlash('success', `Dataset berhasil diimpor: ${rows.length} baris valid, ${skipped} dilewati, ${duplicates} duplikat digabung.`); navigate(`/dataset.php?id=${encodeURIComponent(id)}`);
      } catch (error) { window.alert(error.message); }
    });
  };

  const stopLoading = () => {
    if (loadingTimer !== null) { clearInterval(loadingTimer); loadingTimer = null; }
    document.body.classList.remove('forecast-is-loading');
    const overlay = document.querySelector('[data-forecast-loading]');
    if (overlay) { overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); }
  };

  const showLoading = (form) => {
    const overlay = document.querySelector('[data-forecast-loading]'); if (!overlay) return;
    const model = form.elements.model.value; const horizon = form.elements.horizon.value; const windowSize = form.elements.window.value;
    const epochs = form.elements.epochs?.value || '—'; const hidden = form.elements.hidden_size?.value || '—'; const isLstm = model === 'lstm';
    const messages = isLstm ? ['Memvalidasi dataset dan parameter yang dipilih...', 'Menormalisasi nilai menggunakan skala Min–Max...', 'Membentuk sliding window untuk urutan time series...', 'Melatih jaringan Long Short-Term Memory pada Vercel...', 'Menghitung forecasting recursive multi-step dan interval 95%...', 'Menyiapkan hasil serta checkpoint model...', 'Training masih berlangsung. Waktu proses bergantung pada jumlah data dan epoch...'] : ['Memvalidasi dataset dan parameter yang dipilih...', 'Menyiapkan data historis untuk proses validasi...', 'Menghitung performa model pada data holdout...', 'Membangun forecasting untuk horizon yang dipilih...', 'Menghitung interval dan metrik evaluasi...', 'Menyimpan hasil forecasting ke riwayat...'];
    const names = { auto: 'Otomatis — model statistik terbaik', sma: 'Simple Moving Average', wma: 'Weighted Moving Average', linear: 'Linear Trend', holt: 'Holt Exponential Smoothing', lstm: 'LSTM — Deep Learning' };
    overlay.querySelector('[data-loading-title]').textContent = isLstm ? 'Training dan forecasting LSTM' : 'Menjalankan forecasting';
    overlay.querySelector('[data-loading-message]').textContent = messages[0];
    overlay.querySelector('[data-loading-model]').textContent = names[model] || model.toUpperCase();
    overlay.querySelector('[data-loading-config]').textContent = isLstm ? `Lookback ${windowSize} · ${epochs} epoch · ${hidden} unit · ${horizon} hari` : `Window ${windowSize} · horizon ${horizon} hari`;
    overlay.querySelector('[data-loading-time]').textContent = '00:00';
    overlay.hidden = false; overlay.setAttribute('aria-hidden', 'false'); document.body.classList.add('forecast-is-loading');
    const button = form.querySelector('[data-forecast-submit]'); const label = form.querySelector('[data-submit-label]'); if (button) button.disabled = true; if (label) label.textContent = 'Sedang diproses...';
    const started = Date.now(); let messageIndex = 0;
    loadingTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      overlay.querySelector('[data-loading-time]').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      if (seconds > 0 && seconds % 4 === 0) {
        messageIndex = Math.min(messageIndex + 1, messages.length - 1);
        overlay.querySelector('[data-loading-message]').textContent = messages[messageIndex];
      }
    }, 1000);
  };

  const runForecast = async (form) => {
    const id = params().get('id') || ''; const dataset = datasetById(id); if (!dataset) throw new Error('Dataset tidak ditemukan.');
    const rows = rowsById(id); const values = rows.map((row) => Number(row.value)); const dates = rows.map((row) => row.date);
    const requestedModel = form.elements.model.value; const horizon = Math.max(1, Math.min(90, Number(form.elements.horizon.value || 14)));
    const windowSize = Math.max(5, Math.min(120, Number(form.elements.window.value || 30)));
    const epochs = Math.max(3, Math.min(50, Number(form.elements.epochs?.value || 20)));
    const hiddenSize = Number(form.elements.hidden_size?.value || 32);
    const minimum = requestedModel === 'lstm' ? windowSize + 50 : 30;
    if (values.length < minimum) throw new Error(requestedModel === 'lstm' ? `LSTM dengan lookback ${windowSize} membutuhkan minimal ${minimum} observasi.` : 'Forecasting membutuhkan minimal 30 observasi. Tambahkan data melalui menu CRUD.');
    let selection; let forecast; let training = null; let checkpoint = null; let modelExtension = null;

    if (requestedModel === 'lstm') {
      const response = await fetch('/api/lstm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values, last_date: dates.at(-1), parameters: { lookback: windowSize, horizon, epochs, hidden_size: hiddenSize, batch_size: 128, learning_rate: 0.003, validation_size: 30, patience: 6, seed: 42 } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || result.message || 'Engine LSTM gagal menghasilkan forecasting.');
      selection = { model: 'lstm', label: result.label || modelLabel('lstm'), parameters: result.parameters || {}, metrics: result.metrics || {}, residual_std: Number(result.residual_std || 1) };
      forecast = result.forecast; training = result.training || {}; checkpoint = result.model_checkpoint || null; modelExtension = result.model_extension || 'npz';
    } else {
      await new Promise((resolve) => setTimeout(resolve, 280));
      if (requestedModel === 'auto') selection = selectBestModel(values);
      else {
        const modelParameters = requestedModel === 'holt' ? { alpha: 0.30, beta: 0.10 } : { window: requestedModel === 'linear' ? Math.max(15, windowSize) : windowSize };
        const evaluation = evaluateModel(values, requestedModel, modelParameters, 30);
        selection = { model: requestedModel, label: modelLabel(requestedModel), parameters: modelParameters, ...evaluation };
      }
      forecast = makeForecast(dates, values, selection, horizon);
    }

    if (!forecast?.values?.length) throw new Error('Model tidak menghasilkan output forecasting yang valid.');
    const lastActual = values.at(-1); const endForecast = Number(forecast.values.at(-1));
    const changePercent = lastActual !== 0 ? ((endForecast - lastActual) / lastActual) * 100 : 0;
    const trendLabel = changePercent >= 0.50 ? 'Nilai target diproyeksikan naik' : (changePercent <= -0.50 ? 'Nilai target diproyeksikan turun' : 'Nilai target relatif stabil');
    const historyLength = Math.min(120, values.length); const idRun = uuid('fc');
    const run = { id: idRun, created_at: nowIso(), dataset_id: id, dataset_name: dataset.name, target_column: dataset.target_column, requested_model: requestedModel, model: selection.model, horizon, window: windowSize, selection: { model: selection.model, label: selection.label, parameters: selection.parameters }, metrics: selection.metrics, residual_std: selection.residual_std, last_actual: lastActual, last_date: dates.at(-1), end_forecast: endForecast, change_percent: changePercent, trend_label: trendLabel, history_dates: dates.slice(-historyLength), history_values: values.slice(-historyLength), forecast };
    if (training) run.training = training;
    if (checkpoint) { run.model_checkpoint = checkpoint; run.model_extension = modelExtension; }
    state.forecasts.push(run); saveState(); return run;
  };

  const bindForecastEvents = () => {
    const modelSelect = document.querySelector('[data-model-select]');
    const syncFields = () => {
      const isLstm = modelSelect?.value === 'lstm';
      document.querySelectorAll('[data-lstm-field]').forEach((field) => { field.hidden = !isLstm; field.querySelectorAll('select,input').forEach((input) => { input.disabled = !isLstm; }); });
      const label = document.querySelector('[data-window-label]'); if (label) label.textContent = isLstm ? 'Lookback LSTM' : 'Window';
    };
    modelSelect?.addEventListener('change', syncFields); syncFields();
    document.querySelector('[data-forecast-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget; if (!form.checkValidity() || form.dataset.submitting === 'true') return;
      form.dataset.submitting = 'true'; showLoading(form);
      try {
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 80)));
        const run = await runForecast(form);
        setFlash('success', run.model === 'lstm' ? 'Training dan forecasting LSTM berhasil. Checkpoint model telah disiapkan.' : 'Forecasting berhasil dijalankan dan disimpan ke riwayat.');
        navigate(`/forecast.php?id=${encodeURIComponent(run.dataset_id)}&run=${encodeURIComponent(run.id)}`);
      } catch (error) {
        stopLoading(); form.dataset.submitting = 'false'; const button = form.querySelector('[data-forecast-submit]'); const label = form.querySelector('[data-submit-label]'); if (button) button.disabled = false; if (label) label.textContent = 'Jalankan & Simpan';
        setFlash('error', error.message); renderFlash();
      }
    });
  };

  const bindCommonEvents = () => {
    enrichActionIcons();
    document.querySelectorAll('form[data-confirm]:not([data-dataset-action]):not([data-delete-run])').forEach((form) => {
      if (form.dataset.boundConfirm) return;
      form.dataset.boundConfirm = 'true';
      form.addEventListener('submit', (event) => {
        if (!window.confirm(form.dataset.confirm || 'Yakin ingin melanjutkan?')) event.preventDefault();
      });
    });
    document.querySelectorAll('[data-export-dataset]').forEach((button) => button.addEventListener('click', () => exportDataset(button.dataset.exportDataset)));
    document.querySelectorAll('[data-export-forecast]').forEach((button) => button.addEventListener('click', () => exportForecast(button.dataset.exportForecast)));
    document.querySelectorAll('[data-export-model]').forEach((button) => button.addEventListener('click', () => exportModel(button.dataset.exportModel)));
    document.querySelectorAll('[data-dataset-action]').forEach((form) => form.addEventListener('submit', (event) => {
      event.preventDefault();
      try { handleDatasetAction(form); } catch (error) { setFlash('error', error.message); renderFlash(); }
    }));
    document.querySelectorAll('[data-delete-run]').forEach((form) => form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!window.confirm(form.dataset.confirm || 'Hapus hasil forecasting ini?')) return;
      state.forecasts = state.forecasts.filter((run) => run.id !== form.dataset.deleteRun); saveState(); setFlash('success', 'Riwayat forecasting berhasil dihapus.'); navigate('/history.php');
    }));
    bindUploadEvents();
    bindForecastEvents();
  };

  const renderPage = async () => {
    const page = pathName();
    if (page === '' || page === 'index.php' || page === 'index.html') renderDashboard();
    else if (page === 'datasets.php') renderDatasets();
    else if (page === 'dataset.php') renderDataset();
    else if (page === 'upload.php') renderUpload();
    else if (page === 'forecast.php') renderForecast();
    else if (page === 'history.php') renderHistory();
    else if (page === 'lstm_setup.php') await renderLstmSetup();
    else renderNotFound();
    bindCommonEvents();
  };

  document.querySelector('[data-menu-toggle]')?.addEventListener('click', () => document.querySelector('[data-menu]')?.classList.toggle('open'));
  window.addEventListener('pageshow', (event) => { if (event.persisted) stopLoading(); });

  const init = async () => {
    try {
      state = await loadState(); renderFlash(); await renderPage();
    } catch (error) {
      app.innerHTML = `<div class="container page-content standard-content"><section class="empty-card"><h3>Aplikasi gagal dimuat</h3><p>${escapeHtml(error.message)}</p><button class="button primary" type="button" data-reset-app>Reset Data Aplikasi</button></section></div>`;
      document.querySelector('[data-reset-app]')?.addEventListener('click', () => { localStorage.removeItem(STORAGE_KEY); window.location.reload(); });
    }
  };

  init();
})();
