# Catatan metode LeptoScope

LeptoScope adalah prototype WebGIS untuk **prioritisasi surveilans leptospirosis tingkat kecamatan-bulan di Kota Semarang**. Target model adalah ada/tidaknya kasus tercatat pada bulan berikutnya, bukan jumlah pasien, diagnosis individu, atau probabilitas klinis.

## Evaluasi
- Data pengembangan: 2018–2021.
- Validasi threshold: 2022.
- Evaluasi retrospektif: 2023.
- Model aktif: Logistic Regression Elastic Net, threshold 0,045.
- Mode historis adalah tampilan default untuk demo.

## Pemantauan eksperimental
Mode pemantauan selalu menggunakan **bulan kalender terakhir yang sudah lengkap** sebagai periode input dan memprediksi bulan berikutnya. Contoh: jika tanggal sistem 2 Oktober 2026, input model adalah September 2026 dan target peringatan adalah Oktober 2026. Cuaca diringkas sebagai agregat bulan kalender untuk bulan input dan dua lag sebelumnya. Data kasus operator hanya diterapkan bila 16 kecamatan × 4 bulan sampai periode input lengkap. Mode ini tetap bersifat eksperimental dan belum merupakan sistem operasional tervalidasi.

## Interpretasi
Kelas warna menunjukkan prioritas relatif. Skor bukan diagnosis atau probabilitas klinis. Hasil perlu diverifikasi bersama data surveilans dan penilaian lapangan.
