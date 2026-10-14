# LeptoScope v7.0 — Current Weather & Formal Typography

## Perubahan utama
- Menambahkan cuaca near-real-time Open-Meteo pada 16 titik centroid kecamatan: suhu, kelembapan, presipitasi, hujan, dan kecepatan angin.
- Ringkasan cuaca terkini ditampilkan sebagai rerata 16 titik kecamatan, dengan waktu observasi.
- Detail kecamatan menampilkan kondisi cuaca terkini per centroid kecamatan.
- Cuaca untuk model tetap menggunakan agregat bulan kalender lengkap sebelumnya agar konsisten dengan metodologi model.
- Cache cuaca disegarkan maksimal setiap 30 menit; tombol Perbarui data pemantauan memaksa refresh.
- Tipografi seluruh landing page, WebGIS, panel layer, simulasi, dialog, dan kontrol peta diseragamkan ke Roboto dengan fallback Segoe UI/Arial untuk gaya portal pemerintah yang formal dan bersih.
- Judul pemantauan diperjelas menjadi monitoring kasus + cuaca terkini + peringatan risiko bulanan.

## Catatan interpretasi
Cuaca terkini adalah data Open-Meteo pada centroid kecamatan dan bukan pembacaan stasiun resmi BMKG. Nilai ringkasan kota adalah rerata titik kecamatan.
