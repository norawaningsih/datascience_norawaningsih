# RupiahCast Pro LSTM — Vercel Edition

Versi ini merupakan migrasi aplikasi **RupiahCast Pro LSTM** dari arsitektur lokal **PHP + `proc_open()` + PyTorch** menjadi arsitektur yang dapat dijalankan di **Vercel** tanpa mengubah tema, tata letak, navigasi, kartu, tabel, formulir, grafik, dan alur utama dashboard.

## Arsitektur baru

```text
Browser
├── Dashboard HTML/CSS/JavaScript
├── CRUD dataset dan riwayat di localStorage
├── Forecasting statistik di browser
└── POST /api/lstm
         ↓
FastAPI pada Vercel Python Runtime
└── Engine LSTM NumPy + checkpoint .npz
```

URL lama tetap dipertahankan, termasuk:

- `/index.php`
- `/datasets.php`
- `/dataset.php?id=...`
- `/upload.php`
- `/forecast.php?id=...`
- `/history.php`
- `/lstm_setup.php`
- `/health.php`

Ekstensi `.php` pada URL hanya dipertahankan agar navigasi dan bookmark lama tidak berubah. Halaman tersebut sekarang dilayani oleh satu aplikasi FastAPI dan frontend SPA, bukan oleh runtime PHP.

## Perubahan teknis penting

1. **PHP dihapus dari runtime** dan diganti FastAPI.
2. **`proc_open()` tidak digunakan lagi.** Frontend memanggil endpoint `/api/lstm` secara langsung.
3. **PyTorch diganti LSTM NumPy** agar paket deployment tetap ringan dan lebih sesuai dengan batas fungsi Vercel.
4. Dataset, perubahan CRUD, dan riwayat forecasting disimpan pada **`localStorage` browser** karena filesystem serverless tidak digunakan sebagai penyimpanan permanen.
5. Checkpoint model hasil training dapat diunduh sebagai file **`.npz`**.

## Struktur proyek

```text
rupiahcast-vercel/
├── app.py
├── requirements.txt
├── vercel.json
├── .python-version
├── engine/
│   ├── __init__.py
│   └── numpy_lstm.py
└── public/
    ├── index.html
    ├── assets/
    │   ├── app.js
    │   └── style.css
    └── data/
        └── seed.json
```

## Deploy ke Vercel

1. Ekstrak ZIP ini.
2. Hapus isi aplikasi lama dari repository, lalu upload **seluruh isi folder `rupiahcast-vercel`**. Jangan menumpuknya di atas struktur PHP lama. Pastikan `app.py`, `requirements.txt`, dan `vercel.json` berada di root repository.
3. Di Vercel pilih **Add New → Project**, lalu impor repository tersebut.
4. Pada **Root Directory**, pilih root repository yang berisi `app.py`.
5. Biarkan **Build Command** dan **Output Directory** kosong. Vercel akan mendeteksi FastAPI dari `app.py`.
6. Klik **Deploy**.
7. Setelah selesai, buka `/api/health` untuk memeriksa engine, lalu buka halaman utama.

Jika proyek Vercel lama masih menyimpan konfigurasi build yang salah, buka **Project Settings → Build & Deployment**, lalu kosongkan override Build Command dan Output Directory sebelum melakukan redeploy.

## Menjalankan secara lokal

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload
```

Buka `http://127.0.0.1:8000`.

## Penyimpanan data

- Dataset bawaan dimuat dari `public/data/seed.json` pada kunjungan pertama.
- Upload CSV, CRUD data, dan riwayat forecasting tersimpan di browser yang digunakan.
- Menghapus data situs atau `localStorage` akan mengembalikan aplikasi ke dataset bawaan.
- Data belum tersinkron antarperangkat. Untuk sinkronisasi akun/perangkat, tahap lanjutan memerlukan database eksternal seperti Supabase, Neon, atau Vercel Postgres.

## Format CSV

Aplikasi menerima CSV dengan kolom tanggal dan nilai kurs. Contoh:

```csv
Date,USDIDR
2026-01-02,16668
2026-01-05,16683
```

Frontend mencoba mengenali kolom tanggal dan nilai numerik secara otomatis, lalu menyediakan pratinjau sebelum dataset disimpan.

## Batas konfigurasi LSTM

Agar tetap aman pada lingkungan serverless, engine menerapkan batas:

- lookback maksimum 120;
- epoch maksimum 50;
- hidden unit efektif maksimum 48;
- jumlah sequence training dapat disubsampel secara deterministik.

Konfigurasi yang diminta pengguna tetap ditampilkan, sedangkan respons API juga mencantumkan konfigurasi efektif yang benar-benar digunakan.
