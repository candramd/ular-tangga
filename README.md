# Ular Tangga Adventure

Permainan ular tangga edukatif untuk bermain bersama atau bergantian pada satu perangkat. Frontend Next.js diekspor sebagai situs statis dan menggunakan Supabase RPC untuk sesi, ruang, permainan, bank soal, dan sinkronisasi. Tautan ruang memakai fragment URL (`/#/room/KODE`) agar dapat dibuka dari GitHub Pages tanpa rewrite server.

## Menjalankan secara lokal

Gunakan Node.js 22 atau yang lebih baru:

```sh
npm ci
npm run dev
```

Untuk menghubungkan frontend ke Supabase, siapkan `NEXT_PUBLIC_SUPABASE_URL` dan `NEXT_PUBLIC_SUPABASE_ANON_KEY` di `.env.local`. Nilai anon/publishable memang akan masuk ke bundle browser; otorisasi dan akses data tetap harus ditegakkan oleh RPC dan kebijakan database. Jangan menaruh password database, service-role key, atau rahasia admin di variabel `NEXT_PUBLIC_*`.

Pemeriksaan lokal:

```sh
npm test
npm run typecheck
npm run build
node scripts/check-static-export.mjs out
node scripts/check-game-graphics.mjs
```

Preview hasil ekspor statis di loopback:

```sh
node scripts/static-preview.mjs out
```

Preview tersedia di `http://127.0.0.1:4173`. Untuk menguji jalur situs proyek, set `NEXT_PUBLIC_BASE_PATH=/nama-repo` saat build. Build lokal tanpa base path memakai nilai kosong.

Rehearsal pemulihan snapshot Go hanya boleh memakai snapshot privat dan PostgreSQL loopback disposable. Set `ROLLBACK_REHEARSAL_DATABASE_URL` ke database maintenance lokal, lalu jalankan `python3 scripts/rehearse-go-rollback.py /path/ke/snapshot-privat.json`. Skrip menolak host non-loopback, membuat database bernama acak, memeriksa versi/count/hash snapshot, menjalankan Go sebagai writer tunggal, menguji sesi guest setelah restart, lalu menghapus database uji. Jangan menaruh snapshot, URL berkredensial, atau output privat di Git.

Untuk membandingkan migrasi writer gate secara lokal, jalankan perintah berikut pada PostgreSQL loopback disposable:

```sh
python3 scripts/rehearse_supabase_polling_load.py --through-migration 7
python3 scripts/rehearse_supabase_polling_load.py --through-migration 8
```

Harness membuat database disposable di PostgreSQL loopback, mengisi data sintetis, menjalankan simulasi polling/reconnect/write 30 client, lalu menghapus database. Hasilnya hanya diagnostik SQL lokal, bukan uji kuota Supabase hosted. Tes pembersihan DB memerlukan `RUN_LOCAL_POLLING_DB_TESTS=1 python3 -m unittest tests.test_supabase_polling_load -v`; tanpa flag itu, tes tersebut dilewati. Uji lock Go/RPC pada `tests/integration/supabase-writer-lock.test.mjs` juga memerlukan `TEST_WRITER_LOCK_DATABASE_URL` yang menunjuk database loopback disposable `ular_lock_test_*` yang sudah menjalankan migrasi 008, serta `TEST_ALLOW_WRITER_LOCK_REHEARSAL=true`. Jangan arahkan tes ke database produksi.

Untuk menguji pergantian dua artifact GitHub Pages yang sudah diunduh, jalankan `python3 scripts/rehearse-pages-artifact-rollback.py --current /path/current/artifact.tar --previous /path/previous/artifact.tar --base-path /ular-tangga`. Rehearsal mengekstrak ke direktori sementara dan hanya melayani loopback; ini tidak menerbitkan ulang situs atau mengganti backend.

## Menyiapkan Supabase

Tinjau migrasi di `supabase/migrations/` dan jalankan berurutan pada proyek yang benar-benar dituju. Skrip `scripts/supabase-migrate.sh` menggunakan koneksi PostgreSQL server-side dari `.env`; `scripts/supabase-seed-board.sh` memasang konfigurasi papan awal. Siapkan dan lindungi `.env` secara lokal, jangan commit file itu atau membagikan kredensialnya.

Admin memakai rahasia server yang disimpan sebagai hash privat di database. Provisioning rahasia yang sudah disiapkan dapat dilakukan dengan `python3 scripts/provision-admin-secret.py --from-env`; mode ini memakai `ADMIN_SECRET` yang sudah ada di `.env` dan tidak menggantinya. Jangan menaruh rahasia tersebut di frontend atau di GitHub Pages settings sebagai `NEXT_PUBLIC_*`.

## GitHub Pages

Workflow `.github/workflows/pages.yml` membangun dan menerbitkan folder `out/` ketika ada push ke `main` atau melalui `workflow_dispatch`. Aktifkan GitHub Pages dengan GitHub Actions sebagai source. Atur:

- Repository variable `NEXT_PUBLIC_SUPABASE_URL` ke URL HTTPS proyek.
- Repository secret `NEXT_PUBLIC_SUPABASE_ANON_KEY` ke publishable/anon key.

Workflow menetapkan base path ke nama repository, sesuai URL situs proyek `akun.github.io/nama-repo/`. Untuk domain kustom atau situs akun/organisasi yang berada di root domain, tinjau dan ubah base path workflow sebelum deploy. Room dan game memakai fragment link, contohnya `https://akun.github.io/nama-repo/#/room/KODE`.

Sinkronisasi permainan melakukan polling RPC sekitar 1,2 detik saat game berlangsung dan 2 detik saat menunggu di ruang; saat koneksi gagal interval bertambah sebelum mencoba lagi. Setiap pemain aktif menambah pemakaian RPC dan transfer data. Batas dan biaya bergantung pada paket serta penggunaan proyek Supabase; jangan menganggap kuota gratis cukup tanpa memeriksa pemakaian dan menguji beban yang direncanakan.

**Catatan sesi dan peringkat:** sesi guest tersimpan sebagai token opaque di penyimpanan browser dan berlaku 30 hari. Gunakan origin, profil browser, dan akun pengajar yang sama untuk melanjutkan identitas. Beralih dari `localhost` ke domain GitHub Pages membuat sesi guest baru; database lama tetap tersimpan, tetapi mengetik nama pengajar yang sama tidak memulihkan atau menggabungkan sesi/skor karena nama bukan identitas pemulihan. Skor pemain lokal tetap kumulatif untuk akun pengajar yang sama dan nama anak yang sama setelah normalisasi (spasi tepi dibuang, huruf besar/kecil disamakan). Mengganti akun pengajar atau nama anak menghasilkan identitas peringkat terpisah.

## Status rilis

Situs statis dan cutover Supabase RPC sudah dipublikasikan serta lulus pemeriksaan fungsional dasar. Migrasi 008 menghilangkan kegagalan lock pada beban SQL sintetis lokal; simulasi restore antar-artifact Pages juga lulus di loopback. Penilaian kuota/latensi hosted Supabase dan rollback produksi dari RPC ke writer Go tetap terbuka. Alur kelas mendukung guru sebagai pengendali yang tidak masuk daftar pemain, 2–4 pemain anak, dan perubahan nama profil tanpa mengganti identitas guest. Lihat [RELEASE_READINESS.md](RELEASE_READINESS.md) untuk bukti dan batasan.
