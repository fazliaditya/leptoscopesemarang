# LeptoScope — Elegant WebGIS Release

Versi ini memisahkan **halaman pengantar** dan **ruang analisis peta** supaya pengalaman pengguna tidak langsung masuk ke dashboard teknis.

## Struktur antarmuka

- `/` — beranda: update/berita, pengantar, manfaat, cara kerja, dan pratinjau peta.
- `/map.html` — WebGIS interaktif: evaluasi historis, pemantauan eksperimental, tren, peringkat kecamatan, fasilitas kesehatan, simulasi, dan detail wilayah.
- Panel **Layer & Basemap** berada di dalam peta sehingga kontrol spasial lebih rapi.
- Basemap: Peta Terang dan Satelit.
- Responsif untuk desktop, tablet, dan mobile.

## Menjalankan lokal

```powershell
cd "D:\Website Leptoscope"
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Buka `http://127.0.0.1:8000`.

## Catatan metode

Pemantauan eksperimental memakai **bulan kalender terakhir yang sudah lengkap** untuk memprediksi bulan berjalan. Contoh: pada Oktober 2026, input model adalah September 2026 dan target peringatan adalah Oktober 2026. Data kasus operator hanya digunakan bila matriks periode yang diwajibkan lengkap; jika tidak, sistem menampilkan status fallback historis.

Skor LeptoScope adalah peringatan relatif untuk prioritisasi surveilans, bukan diagnosis klinis.

## Refined UI
Versi ini menggunakan OpenStreetMap Standard sebagai basemap utama dan Esri World Imagery sebagai opsi citra. Berita pada landing page menggunakan tautan resmi WHO/Kemenkes dengan ilustrasi berlisensi terbuka yang diberi atribusi pada halaman.

## Pembaruan data kasus melalui WebGIS (v6.2)

Mode **Eksperimental** sekarang memiliki modul **Pembaruan Data Kasus** langsung di halaman WebGIS.

Alur penggunaan:

1. Buka mode **Eksperimental**.
2. Klik **Unduh template**. Template dibuat otomatis mengikuti tanggal sistem.
3. Isi `case_count` di Excel. Nilai `0` berarti nihil kasus terverifikasi; sel kosong berarti data belum diterima.
4. Klik **Unggah Excel / CSV**.
5. Sistem memvalidasi periode, kecamatan, duplikasi, bilangan kasus, kelengkapan empat bulan penuh, dan data bulan berjalan.
6. Periksa preview, lalu klik **Terapkan & perbarui peta**.

Sistem menggunakan dua jalur waktu:

- **Monitoring bulan berjalan**: boleh parsial dan dapat diperbarui kapan saja. Data ini hanya ditampilkan sebagai kasus sementara.
- **Peringatan model**: selalu memakai empat bulan kalender lengkap terakhir. Pada Oktober 2026, window model adalah Juni–September 2026 dan target peringatan adalah Oktober 2026.

Upload ulang tidak menjumlahkan data ganda. Nilai pada kombinasi kecamatan–bulan yang sama akan diperbarui. Saat bulan berganti, periode template dan window model bergeser otomatis berdasarkan tanggal sistem.

Catatan deployment: penyimpanan `data_live/kasus_terbaru.csv` cocok untuk penggunaan lokal atau server dengan persistent disk. Pada hosting dengan filesystem ephemeral, gunakan persistent disk/database agar data upload tidak hilang saat instance restart.


## Pembaruan v7.0
Mode Terkini menampilkan kondisi cuaca near-real-time Open-Meteo (suhu, kelembapan, presipitasi, dan angin) sebagai konteks monitoring. Model peringatan tetap menggunakan agregat cuaca bulan kalender lengkap sebelumnya. Tipografi antarmuka diseragamkan ke Roboto/Segoe UI/Arial.
