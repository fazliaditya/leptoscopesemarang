# Deployment

## Render
1. Upload seluruh isi folder ini ke satu repository GitHub.
2. Di Render pilih **New → Blueprint** dan hubungkan repository.
3. Render membaca `render.yaml`, menginstal `requirements.txt`, lalu menjalankan Uvicorn.
4. Health check: `/api/health`.

Alternatif manual: buat Python Web Service dengan build command `pip install -r requirements.txt` dan start command `uvicorn backend.app:app --host 0.0.0.0 --port $PORT`.

## Docker / platform lain
Repository juga memiliki `Dockerfile`; platform yang mendukung container dapat membangun langsung dari root repository.

## Catatan penyimpanan
`data_live/weather_cache.json` dan `data_live/kasus_terbaru.csv` tidak dimasukkan ke Git secara default. Pada hosting dengan filesystem ephemeral, cache/data operator lokal dapat hilang ketika instance diganti. Untuk demo seleksi, mode historis tetap berjalan tanpa file operator.
