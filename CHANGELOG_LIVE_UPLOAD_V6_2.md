# LeptoScope v6.2 — Live Case Upload

- Menambah upload Excel/CSV langsung dari mode Eksperimental.
- Menambah template Excel dinamis untuk empat bulan lengkap + bulan berjalan.
- Menambah validasi otomatis kecamatan, periode, duplikasi, nilai kasus, dan kelengkapan model.
- Menambah preview data sebelum diterapkan.
- Upload bersifat merge/update per kecamatan–bulan, bukan penjumlahan berulang.
- Monitoring bulan berjalan boleh parsial dan tidak masuk model sampai bulan tersebut selesai.
- Model tetap menggunakan empat bulan kalender lengkap terakhir secara rolling otomatis.
- Menambah kasus sementara bulan berjalan pada ringkasan dan detail kecamatan.
- Tidak menambah dependency Python baru; upload dikirim sebagai raw file body.
