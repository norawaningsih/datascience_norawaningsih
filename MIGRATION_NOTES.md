# Catatan Migrasi

## Yang dipertahankan

- Identitas visual RupiahCast Pro LSTM.
- CSS utama, warna, tipografi, layout responsif, kartu, tabel, form, tombol, ikon, animasi, dan grafik.
- Menu Dashboard, Dataset, Upload CSV, Riwayat, dan LSTM.
- URL navigasi lama berakhiran `.php`.
- CRUD time series, impor/ekspor CSV, forecasting statistik, forecasting LSTM, metrik, interval, riwayat, dan unduh model.

## Yang diubah

| Sebelum | Sesudah |
|---|---|
| PHP multi-page | FastAPI + frontend SPA |
| `proc_open()` ke Python | Request HTTP ke `/api/lstm` |
| PyTorch lokal | LSTM NumPy serverless |
| File JSON/CSV pada server | `localStorage` browser |
| Checkpoint `.pt` | Checkpoint `.npz` |
| XAMPP/VPS | Vercel Python Runtime |

## Konsekuensi

Penyimpanan saat ini bersifat per browser. Solusi ini sengaja dipilih agar proyek dapat langsung di-deploy tanpa database dan tanpa mengubah pengalaman visual. Untuk penggunaan multiuser, penyimpanan perlu dipindahkan ke database eksternal pada tahap berikutnya.
