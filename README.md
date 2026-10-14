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

Panel guru (`/guru/`) memakai nama pengguna dan kata sandi Supabase Auth. Nama pengguna 3–24 karakter ASCII (`a–z`, angka, titik, `_`, `-`), harus diawali dan diakhiri huruf/angka, tidak boleh berisi titik berurutan, tidak peka huruf besar/kecil, dan nama sistem seperti `admin` atau `guru` dicadangkan. Frontend mengubah nama itu menjadi alamat internal di domain `.invalid`; alamat ini tidak dapat menerima email dan tidak ditampilkan. Aktifkan password signup dan matikan Confirm email di Supabase Auth agar pendaftaran langsung mendapat sesi. Tidak ada verifikasi atau pemulihan lewat email. `/admin/` tetap menjadi alias halaman guru lama.

Migration 009 (`009_username_teachers.sql`) menambahkan tabel role guru, bank privat tiap guru, dan proyeksi soal aktif untuk permainan bersama. Uji migration pada database disposable terlebih dahulu. Akun Supabase Auth mendapat role `teacher` dari database; role yang diizinkan hanya `teacher` dan `student`. Tidak ada login admin atau bootstrap admin. Guest yang bermain tanpa login tetap dapat membuat atau bergabung ke ruang publik dan memakai soal aktif dari semua guru; ruang yang dibuat guru hanya memakai bank soal guru tersebut. Jawaban benar tidak disertakan dalam proyeksi publik.

```sql
INSERT INTO public.ular_teacher_roles(user_id, role, active)
VALUES ('<UUID dari auth.users>', 'student', true)
ON CONFLICT (user_id) DO UPDATE SET role = 'student', active = true;
```

Gunakan perubahan role tepercaya ini hanya bila akun harus diturunkan menjadi siswa, dan `active = false` untuk menonaktifkan akun. Jangan hapus baris role: akun yang kembali memperoleh role guru default kecuali barisnya disimpan dengan role/active yang lebih restriktif. Role browser, request body, dan `user_metadata` tidak pernah memberi kewenangan. Route admin dan bearer admin lama ditolak oleh dispatcher hosted setelah migration 009. Soal aktif lama yang tersimpan di snapshot global tidak diklaim oleh guru pertama; soal itu tetap tersedia pada pool bersama untuk ruang guest. Pemindahan soal lama ke guru tertentu hanya boleh dilakukan melalui skrip SQL tepercaya setelah pemiliknya dipastikan.

Pengikatan sesi guru serta bank soal relasional hanya tersedia saat frontend memakai Supabase RPC. Server Go lama adalah rollback kompatibilitas untuk data/fitur sebelumnya; server itu belum menerapkan otorisasi username/password dan model bank soal multi-guru, sehingga jangan mengarahkannya ke aplikasi guru baru. Konfigurasikan Supabase Auth untuk password signup tanpa konfirmasi email dan jalankan migration 009 sebelum rilis frontend baru. Karena tidak ada email reset, sediakan prosedur pemulihan akun tepercaya sebelum penggunaan luas.

## GitHub Pages

Workflow `.github/workflows/pages.yml` membangun dan menerbitkan folder `out/` ketika ada push ke `main` atau melalui `workflow_dispatch`. Aktifkan GitHub Pages dengan GitHub Actions sebagai source. Atur:

- Repository variable `NEXT_PUBLIC_SUPABASE_URL` ke URL HTTPS proyek.
- Repository secret `NEXT_PUBLIC_SUPABASE_ANON_KEY` ke publishable/anon key.

Workflow menetapkan base path ke nama repository, sesuai URL situs proyek `akun.github.io/nama-repo/`. Untuk domain kustom atau situs akun/organisasi yang berada di root domain, tinjau dan ubah base path workflow sebelum deploy. Room dan game memakai fragment link, contohnya `https://akun.github.io/nama-repo/#/room/KODE`.

Sinkronisasi permainan melakukan polling RPC sekitar 1,2 detik saat game berlangsung dan 2 detik saat menunggu di ruang; saat koneksi gagal interval bertambah sebelum mencoba lagi. Setiap pemain aktif menambah pemakaian RPC dan transfer data. Batas dan biaya bergantung pada paket serta penggunaan proyek Supabase; jangan menganggap kuota gratis cukup tanpa memeriksa pemakaian dan menguji beban yang direncanakan.

**Catatan sesi dan peringkat:** sesi guest tersimpan sebagai token opaque di penyimpanan browser dan berlaku 30 hari. Login memakai UUID akun Supabase sebagai identitas pengajar, roster siswa lokal, dan pemilik ruang sehingga tetap sama di origin/perangkat yang berbeda dalam proyek Supabase yang sama. Sesi guest lama tidak otomatis digabung ke akun guru; saat pertama kali beralih, browser melepaskan token dan penunjuk ruang guest lokalnya. Data guest lama tetap tersimpan sebagai identitas terpisah. Skor siswa lokal berlanjut untuk akun pengajar yang sama dan nama anak yang sama setelah normalisasi (spasi tepi dibuang, huruf besar/kecil disamakan). Mengganti akun pengajar atau nama anak menghasilkan identitas peringkat terpisah.

## Status rilis

Situs statis dan cutover Supabase RPC sudah dipublikasikan serta lulus pemeriksaan fungsional dasar. Migrasi 008 menghilangkan kegagalan lock pada beban SQL sintetis lokal; simulasi restore antar-artifact Pages juga lulus di loopback. Penilaian kuota/latensi hosted Supabase dan rollback produksi dari RPC ke writer Go tetap terbuka. Alur kelas mendukung guru sebagai pengendali yang tidak masuk daftar pemain, 2–4 pemain anak, dan perubahan nama profil tanpa mengganti identitas guest. Lihat [RELEASE_READINESS.md](RELEASE_READINESS.md) untuk bukti dan batasan.
