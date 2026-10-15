"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleHelp, Dice5, FileEdit, Home, Leaf, LoaderCircle, LogOut, Plus, Save, Search, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { AdminApiError, createQuestion, createTeacherGameSession, deleteQuestion, getQuestions, logoutTeacherGameSession, updateQuestion, type AdminQuestion } from "@/services/admin";
import { clearTeacherActorId, getTeacherSession, setTeacherActorId, signInTeacherWithUsername, signOutTeacher, signUpTeacherWithUsername, supabaseAuth } from "@/services/supabase-auth";
import { shouldReconcileAuthIdentity } from "@/services/auth-transition";
import { clearSessionTokens } from "@/services/api";
import { useGameStore } from "@/stores/game.store";

const homeHref = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`;

type Status = "loading" | "logged-out" | "ready";
type AuthMode = "login" | "signup";
type Difficulty = AdminQuestion["difficulty"];
type StatusFilter = "semua" | "aktif" | "nonaktif";
type ModalState = { mode: "create" } | { mode: "edit"; id: string } | null;

type Draft = {
  question: string;
  options: string[];
  answer: number;
  explanation: string;
  category: string;
  difficulty: Difficulty;
  timeLimit: number;
  active: boolean;
};

const emptyDraft = (): Draft => ({
  question: "",
  options: ["", ""],
  answer: 0,
  explanation: "",
  category: "",
  difficulty: "mudah",
  timeLimit: 30,
  active: true,
});

function validateDraft(draft: Draft): string {
  const question = draft.question.trim();
  if (question.length < 3 || question.length > 500) return "Pertanyaan harus berisi 3 hingga 500 karakter.";
  if (draft.options.length < 2 || draft.options.length > 6) return "Soal harus memiliki 2 hingga 6 pilihan jawaban.";
  const seen = new Set<string>();
  for (const raw of draft.options) {
    const option = raw.trim();
    if (!option) return "Semua pilihan jawaban harus diisi.";
    if (option.length > 120) return "Setiap pilihan jawaban maksimal 120 karakter.";
    const key = option.toLowerCase();
    if (seen.has(key)) return "Pilihan jawaban tidak boleh ada yang sama.";
    seen.add(key);
  }
  if (!Number.isInteger(draft.answer) || draft.answer < 0 || draft.answer >= draft.options.length) return "Tandai satu pilihan sebagai jawaban benar.";
  if (draft.explanation.trim().length > 500) return "Penjelasan maksimal 500 karakter.";
  if (draft.category.trim().length > 40) return "Kategori maksimal 40 karakter.";
  if (!Number.isInteger(draft.timeLimit) || draft.timeLimit < 10 || draft.timeLimit > 120) return "Batas waktu harus antara 10 hingga 120 detik.";
  return "";
}

export default function AdminApp() {
  const [status, setStatus] = useState<Status>("loading");
  const [questions, setQuestions] = useState<AdminQuestion[]>([]);
  const [persistenceEnabled, setPersistenceEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("semua");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const teacherOwnerRef = useRef<string | null>(null);
  const isRestoringSessionRef = useRef(true);

  const handleError = useCallback((e: unknown) => {
    if (e instanceof AdminApiError && e.status === 404) {
      setStatus("logged-out");
      setError("Panel guru belum tersedia. Silakan coba lagi nanti.");
      return;
    }
    setError(e instanceof Error ? e.message : "Terjadi kesalahan. Coba lagi.");
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && modal && !dialog.open) dialog.showModal();
  }, [modal]);

  useEffect(() => {
    const dialog = confirmRef.current;
    if (dialog && confirmId && !dialog.open) dialog.showModal();
  }, [confirmId]);

  useEffect(() => {
    let cancelled = false;
    isRestoringSessionRef.current = true;
    async function restore() {
      try {
        const authSession = await getTeacherSession();
        if (cancelled) return;
        teacherOwnerRef.current = authSession?.user.id ?? null;
        isRestoringSessionRef.current = false;
        if (!authSession) { if (!cancelled) setStatus("logged-out"); return; }
        const teacher = await createTeacherGameSession();
        if (cancelled) return;
        setTeacherActorId(teacher.id);
        setPersistenceEnabled(true);
        const bank = await getQuestions();
        if (cancelled) return;
        setQuestions(bank.questions);
        setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          isRestoringSessionRef.current = false;
          if (e instanceof AdminApiError && e.status === 401) {
            setStatus("logged-out");
          } else {
            handleError(e);
            setStatus("logged-out");
          }
        }
      }
    }
    void restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return;
    const { data } = supabaseAuth().auth.onAuthStateChange((event, session) => {
      const nextId = session?.user.id ?? null;
      if (shouldReconcileAuthIdentity({ currentOwnerId: teacherOwnerRef.current, nextOwnerId: nextId, event, isRestoringSession: isRestoringSessionRef.current })) {
        teacherOwnerRef.current = nextId;
        clearSessionTokens(); clearTeacherActorId(); sessionStorage.removeItem("adventure-room");
        useGameStore.getState().resetGameplay(); setQuestions([]); setStatus("logged-out");
        if (nextId) window.setTimeout(() => window.location.reload(), 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function login(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setAuthNotice("");
    try {
      if (authMode === "signup") {
        if (authPassword !== authPasswordConfirm) throw new Error("Konfirmasi kata sandi belum cocok.");
        if (authPassword.length < 8) throw new Error("Kata sandi harus berisi minimal 8 karakter.");
        await signUpTeacherWithUsername(authUsername, authPassword);
        setAuthPassword(""); setAuthPasswordConfirm("");
        setAuthNotice("Akun guru berhasil dibuat. Menyiapkan panel...");
      } else {
        await signInTeacherWithUsername(authUsername, authPassword);
      }
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError("");
    let remoteFailure = false;
    try { await logoutTeacherGameSession(); } catch { remoteFailure = true; }
    try { await signOutTeacher(); } catch { remoteFailure = true; }
    clearSessionTokens(); clearTeacherActorId(); sessionStorage.removeItem("adventure-room");
    useGameStore.getState().resetGameplay(); setQuestions([]); setStatus("logged-out");
    if (remoteFailure) setError("Anda sudah keluar di perangkat ini. Server belum dapat menyimpan sebagian perubahan.");
    setBusy(false);
  }

  function openCreate() {
    setDraft(emptyDraft());
    setFormError("");
    setModal({ mode: "create" });
  }

  function openEdit(question: AdminQuestion) {
    setDraft({
      question: question.question,
      options: [...question.options],
      answer: question.answer,
      explanation: question.explanation,
      category: question.category,
      difficulty: question.difficulty,
      timeLimit: question.timeLimit,
      active: question.active,
    });
    setFormError("");
    setModal({ mode: "edit", id: question.id });
  }

  function closeForm() {
    if (!saving) setModal(null);
  }

  function setAnswer(index: number) {
    setDraft((current) => ({ ...current, answer: index }));
  }

  function setOption(index: number, value: string) {
    setDraft((current) => ({ ...current, options: current.options.map((option, i) => (i === index ? value : option)) }));
  }

  function addOption() {
    setDraft((current) => (current.options.length >= 6 ? current : { ...current, options: [...current.options, ""] }));
  }

  function removeOption(index: number) {
    setDraft((current) => {
      if (current.options.length <= 2) return current;
      const options = current.options.filter((_, i) => i !== index);
      const answer = current.answer === index ? -1 : current.answer > index ? current.answer - 1 : current.answer;
      return { ...current, options, answer };
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const problem = validateDraft(draft);
    if (problem) {
      setFormError(problem);
      return;
    }
    const target = modal;
    setSaving(true);
    setFormError("");
    const payload = {
      question: draft.question.trim(),
      options: draft.options.map((option) => option.trim()),
      answer: draft.answer,
      explanation: draft.explanation.trim(),
      category: draft.category.trim(),
      difficulty: draft.difficulty,
      timeLimit: draft.timeLimit,
      active: draft.active,
    };
    try {
      const saved = target?.mode === "edit" ? await updateQuestion(target.id, payload) : await createQuestion(payload);
      setQuestions((current) => target?.mode === "edit" ? current.map((q) => (q.id === saved.id ? saved : q)) : [...current, saved]);
      setModal(null);
      setNotice(target?.mode === "edit" ? "Soal berhasil diperbarui." : "Soal baru berhasil ditambahkan.");
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        setModal(null);
        setQuestions([]);
        setStatus("logged-out");
        setError("Sesi guru berakhir. Masuk kembali untuk melanjutkan.");
        return;
      }
      setFormError(err instanceof AdminApiError ? err.message : "Gagal menyimpan soal. Coba lagi.");
      return;
    } finally {
      setSaving(false);
    }
  }

  function openDelete(question: AdminQuestion) {
    if (saving) return;
    setConfirmId(question.id);
    setDeleteError("");
  }

  function closeConfirm() {
    if (!deleting) setConfirmId(null);
  }

  async function removeQuestion() {
    if (deleting || !confirmId) return;
    const id = confirmId;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteQuestion(id);
      setQuestions((current) => current.filter((q) => q.id !== id));
      setConfirmId(null);
      setNotice("Soal berhasil dihapus dari bank soal.");
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        setConfirmId(null);
        setQuestions([]);
        setStatus("logged-out");
        setError("Sesi guru berakhir. Masuk kembali untuk melanjutkan.");
        return;
      }
      if (err instanceof AdminApiError && err.status === 404) {
        setQuestions((current) => current.filter((q) => q.id !== id));
        setConfirmId(null);
        setNotice("Soal sudah tidak ada pada bank soal.");
        return;
      }
      setDeleteError(err instanceof AdminApiError ? err.message : "Gagal menghapus soal. Coba lagi.");
      return;
    } finally {
      setDeleting(false);
    }
  }

  const needle = search.trim().toLowerCase();
  const visibleQuestions = questions.filter((q) => {
    if (statusFilter === "aktif" && !q.active) return false;
    if (statusFilter === "nonaktif" && q.active) return false;
    if (!needle) return true;
    return [q.question, q.category, ...q.options].join(" ").toLowerCase().includes(needle);
  });

  if (status === "loading") {
    return <div className="admin-shell"><div className="admin-workspace"><div className="scene-loading"><LoaderCircle size={34} /><span>Memeriksa sesi guru...</span></div></div></div>;
  }

  if (status === "logged-out") {
    return <div className="admin-shell"><div className="admin-workspace"><main className="admin-main">
      <div className="page-heading"><div><div className="admin-eyebrow"><span /> AREA PENGAJAR</div><h1>{authMode === "signup" ? "Daftar akun guru" : "Masuk panel pengajar"}</h1><p className="admin-login-description">Gunakan nama pengguna dan kata sandi untuk mengelola bank soal pribadi.</p></div></div>
      {error && <div className="admin-alert error" role="alert"><TriangleAlert size={18} /><span>{error}</span><button aria-label="Tutup pesan kesalahan" onClick={() => setError("")}><X size={16} /></button></div>}
      {authNotice && <div className="admin-alert" role="status"><ShieldCheck size={18} /><span>{authNotice}</span></div>}
      <div className="admin-modal">
        <div className="admin-modal-head"><h2>Akun pengajar</h2><a className="admin-help-link" href={homeHref}><Home size={14} />Beranda</a></div>
        <form className="admin-login-form" onSubmit={(e) => void login(e)}>
          <div className="admin-form-field"><label className="admin-field-label" htmlFor="teacher-username">Nama pengguna</label><input id="teacher-username" className="admin-input" type="text" autoComplete="username" minLength={3} maxLength={24} value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} required /></div>
          <div className="admin-form-field"><label className="admin-field-label" htmlFor="teacher-password">Kata sandi</label><input id="teacher-password" className="admin-input" type="password" autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength={authMode === "signup" ? 8 : undefined} value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required /></div>
          {authMode === "signup" && <div className="admin-form-field"><label className="admin-field-label" htmlFor="teacher-password-confirm">Ulangi kata sandi</label><input id="teacher-password-confirm" className="admin-input" type="password" autoComplete="new-password" minLength={8} value={authPasswordConfirm} onChange={(e) => setAuthPasswordConfirm(e.target.value)} required /></div>}
          <button className="admin-button primary full" disabled={busy}>
            {busy ? <><LoaderCircle size={17} />Memproses...</> : authMode === "signup" ? "Buat akun guru" : "Masuk"}
          </button>
          <button className="admin-help-link" type="button" onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setError(""); setAuthNotice(""); }}> {authMode === "signup" ? "Sudah punya akun? Masuk" : "Belum punya akun? Daftar sebagai guru"}</button>
          <p className="admin-login-note"><ShieldCheck size={15} />Nama pengguna tidak dapat diubah dan tidak memakai email. Setiap pengajar memiliki bank soal dan ruang kelas sendiri.</p>
          <a className="admin-help-link" href={homeHref}><Home size={14} />Kembali ke beranda</a>
        </form>
      </div>
    </main></div></div>;
  }

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <a className="admin-brand" href={homeHref} aria-label="Ular Tangga Adventure beranda"><span className="admin-brand-symbol"><Dice5 size={29} strokeWidth={2.4} /><Leaf className="admin-brand-leaf" size={17} /></span><span>ular tangga<span className="admin-brand-sub">GURU</span></span></a>
      <div className="admin-nav-caption">PANEL PENGAJAR</div>
      <nav className="admin-nav" aria-label="Navigasi guru">
        <span className="admin-nav-item active" aria-current="page"><FileEdit size={19} /><span>Bank soal</span></span>
      </nav>
      <div className="admin-sidebar-bottom"><a className="admin-nav-item" href={homeHref} aria-label="Kembali ke beranda"><Home size={19} /><span>Beranda</span></a></div>
    </aside>
    <div className="admin-workspace">
      <header className="admin-topbar">
        <div className="admin-breadcrumb"><span>Panel guru</span><strong>Bank soal</strong></div>
        <div className="admin-topbar-actions">
          <button className="admin-button secondary small" disabled={busy} onClick={() => void logout()}><LogOut size={15} />Keluar</button>
        </div>
      </header>
      <main className="admin-main">
        <div className="admin-page-heading">
          <div><div className="admin-eyebrow"><span /> BANK SOAL PERMAINAN</div><h1>Daftar pertanyaan</h1><p>{questions.length ? (visibleQuestions.length === questions.length ? `${questions.length} soal terdaftar pada bank soal.` : `${visibleQuestions.length} dari ${questions.length} soal ditampilkan.`) : "Belum ada soal pada bank soal."}</p></div>
          <button className="admin-button primary" onClick={openCreate}><Plus size={16} />Tambah soal</button>
        </div>
        {!persistenceEnabled && <div className="admin-warning" role="status"><TriangleAlert size={18} /><span><strong>Penyimpanan belum aktif.</strong>Bank soal saat ini hanya tersimpan di memori server dan akan hilang saat server dimulai ulang.</span></div>}
        {error && <div className="admin-alert error" role="alert"><CircleHelp size={18} /><span>{error}</span><button aria-label="Tutup pesan kesalahan" onClick={() => setError("")}><X size={16} /></button></div>}
        {notice && <div className="admin-toast" role="status"><Check size={17} />{notice}</div>}
        <div className="admin-persistence-note"><ShieldCheck size={14} />Permainan hanya memakai soal aktif milik Anda. Tambahkan dan aktifkan setidaknya satu soal sebelum memulai. Perubahan soal berlaku untuk permainan baru.</div>
        <div className="admin-search-filter">
          <div className="admin-search-field">
            <input className="admin-input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari pertanyaan, kategori, atau pilihan..." aria-label="Cari soal" />
          </div>
          <div className="admin-filter-field">
            <select className="admin-select admin-filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Saring status soal">
              <option value="semua">Semua status</option>
              <option value="aktif">Aktif</option>
              <option value="nonaktif">Nonaktif</option>
            </select>
          </div>
        </div>
        {questions.length === 0 ? <div className="admin-questions-empty"><Leaf size={40} /><p>Bank soal Anda masih kosong. Pilih Tambah soal untuk membuat pertanyaan pertama. Permainan belum dapat dimulai sampai ada soal aktif.</p></div> : visibleQuestions.length === 0 ? <div className="admin-questions-empty"><Search size={40} /><p>Tidak ada soal yang cocok dengan kata kunci atau saringan status. Coba kata kunci lain atau tampilkan semua status.</p></div> : visibleQuestions.map((q) => <div className="admin-question-card" key={q.id}>
          <div className="admin-question-header">
            <div className="admin-question-meta"><span className={`admin-question-badge ${q.active ? "active" : "inactive"}`}>{q.active ? "Aktif" : "Nonaktif"}</span><span className="admin-question-badge">{q.category}</span><span className="admin-question-badge admin-question-difficulty">{q.difficulty}</span><span>{q.timeLimit} dtk</span></div>
          </div>
          <p className="admin-question-text">{q.question}</p>
          <div className="admin-question-options">
            {q.options.map((option, index) => <div className={`admin-question-option ${index === q.answer ? "correct" : ""}`} key={index}><span className="admin-question-option-letter">{String.fromCharCode(65 + index)}</span>{option}{index === q.answer && <Check size={15} />}</div>)}
          </div>
          {q.explanation && <p className="admin-login-description">{q.explanation}</p>}
          <div className="admin-question-actions">
            <button className="admin-button secondary small" onClick={() => openEdit(q)}><FileEdit size={14} />Ubah</button>
            <button className="admin-button danger small" onClick={() => openDelete(q)}><Trash2 size={14} />Hapus</button>
          </div>
        </div>)}
      </main>
    </div>

    {modal && (
      <dialog ref={dialogRef} className="admin-modal" aria-labelledby="admin-form-title" onCancel={(e) => { if (saving) e.preventDefault(); closeForm(); }} onClick={(e) => { if (e.target === e.currentTarget) closeForm(); }}>
        <div className="admin-modal-head">
          <h2 id="admin-form-title">{modal.mode === "edit" ? "Ubah soal" : "Soal baru"}</h2>
          <button type="button" className="admin-button secondary icon-only" aria-label="Tutup" onClick={closeForm} disabled={saving}><X size={16} /></button>
        </div>
        <p>Lengkapi detail soal di bawah. Pilihan dapat ditambah hingga 6 butir dan satu di antaranya ditandai sebagai jawaban benar.</p>
        <form onSubmit={(e) => void save(e)} aria-describedby={formError ? "admin-form-error" : undefined}>
          <label className="admin-field-label" htmlFor="question-text">Pertanyaan</label>
          <textarea id="question-text" className="admin-textarea" autoFocus required maxLength={500} value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} placeholder="Tulis pertanyaan di sini..." disabled={saving} />

          <span className="admin-field-label">Pilihan jawaban</span>
          <div className="admin-options-list">
            {draft.options.map((option, index) => (
              <div className="admin-option-row" key={index}>
                <input
                  type="radio"
                  className="admin-option-radio"
                  name="correct-answer"
                  checked={draft.answer === index}
                  onChange={() => setAnswer(index)}
                  aria-label={`Jawaban benar ${String.fromCharCode(65 + index)}`}
                  disabled={saving}
                />
                <input
                  className="admin-option-input"
                  value={option}
                  maxLength={120}
                  placeholder={`Pilihan ${String.fromCharCode(65 + index)}`}
                  aria-label={`Pilihan ${String.fromCharCode(65 + index)}`}
                  onChange={(e) => setOption(index, e.target.value)}
                  disabled={saving}
                />
                <button type="button" className="admin-option-remove" onClick={() => removeOption(index)} disabled={saving || draft.options.length <= 2} aria-label={`Hapus pilihan ${String.fromCharCode(65 + index)}`}><X size={15} /></button>
              </div>
            ))}
          </div>
          <button type="button" className="admin-option-add" onClick={addOption} disabled={saving || draft.options.length >= 6}><Plus size={14} />Tambah pilihan</button>
          <p className="admin-option-count">{draft.options.length} dari 6 pilihan · tandai radio untuk jawaban benar</p>

          <div className="admin-form-row">
            <div>
              <label className="admin-field-label" htmlFor="question-category">Kategori</label>
              <input id="question-category" className="admin-input" maxLength={40} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="Contoh: Matematika" disabled={saving} />
            </div>
            <div>
              <label className="admin-field-label" htmlFor="question-difficulty">Kesulitan</label>
              <select id="question-difficulty" className="admin-select" value={draft.difficulty} onChange={(e) => setDraft({ ...draft, difficulty: e.target.value as Difficulty })} disabled={saving}>
                <option value="mudah">Mudah</option>
                <option value="sedang">Sedang</option>
                <option value="sulit">Sulit</option>
              </select>
            </div>
          </div>

          <label className="admin-field-label" htmlFor="question-time">Batas waktu (detik)</label>
          <input id="question-time" className="admin-input" type="number" min={10} max={120} value={draft.timeLimit} onChange={(e) => setDraft({ ...draft, timeLimit: Number(e.target.value) })} disabled={saving} />

          <label className="admin-field-label" htmlFor="question-explanation">Penjelasan</label>
          <textarea id="question-explanation" className="admin-textarea" maxLength={500} value={draft.explanation} onChange={(e) => setDraft({ ...draft, explanation: e.target.value })} placeholder="Penjelasan jawaban benar (opsional)" disabled={saving} />

          <label className="admin-active-row">
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} disabled={saving} />
            Soal aktif — ditampilkan dalam permainan
          </label>

          {formError && <p id="admin-form-error" className="admin-form-error" role="alert">{formError}</p>}

          <div className="admin-modal-actions">
            <button type="button" className="admin-button secondary" onClick={closeForm} disabled={saving}>Batal</button>
            <button type="submit" className="admin-button primary" disabled={saving}>
              {saving ? <><LoaderCircle size={15} />Menyimpan...</> : <><Save size={15} />{modal.mode === "edit" ? "Simpan perubahan" : "Tambah soal"}</>}
            </button>
          </div>
        </form>
      </dialog>
    )}

    {confirmId && (
      <dialog ref={confirmRef} className="admin-modal" aria-labelledby="admin-confirm-title" aria-describedby={deleteError ? "admin-delete-error" : undefined} onCancel={(e) => { if (deleting) e.preventDefault(); closeConfirm(); }} onClick={(e) => { if (e.target === e.currentTarget) closeConfirm(); }}>
        <div className="admin-modal-head">
          <h2 id="admin-confirm-title">Hapus soal?</h2>
          <button type="button" className="admin-button secondary icon-only" aria-label="Tutup" onClick={closeConfirm} disabled={deleting}><X size={16} /></button>
        </div>
        <p>Tindakan ini tidak dapat dibatalkan. Soal berikut akan dihapus permanen dari bank soal.</p>
        {(() => {
          const target = questions.find((q) => q.id === confirmId);
          return target ? <p className="admin-question-text">{target.question}</p> : null;
        })()}
        {deleteError && <p id="admin-delete-error" className="admin-form-error" role="alert">{deleteError}</p>}
        <div className="admin-modal-actions">
          <button type="button" className="admin-button secondary" onClick={closeConfirm} disabled={deleting}>Batal</button>
          <button type="button" className="admin-button danger" onClick={() => void removeQuestion()} disabled={deleting}>
            {deleting ? <><LoaderCircle size={15} />Menghapus...</> : <><Trash2 size={15} />Ya, hapus permanen</>}
          </button>
        </div>
      </dialog>
    )}
  </div>;
}
