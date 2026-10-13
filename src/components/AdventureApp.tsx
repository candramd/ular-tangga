"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState, useId, type ReactNode, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight, CircleHelp, Compass, Copy, Crown, Dice5, Flag, Leaf, LockKeyhole, LogOut, Maximize2, Mountain, Plus, RotateCcw, Settings2, ShieldCheck, Smartphone, Sparkles, Timer, Trophy, Users, Wifi, WifiOff, X, Zap } from "lucide-react";
import { api, ApiError, claimLocalMigrationSession, requestId } from "@/services/api";
import { readStoredSetting, resolveQuality, resolveReducedMotion } from "@/services/settings";
import { DICE_RELEASE_MS, DICE_ROLL_DURATION_MS } from "@/game/dice-motion";
import { connectGame } from "@/services/websocket";
import { serverNow } from "@/services/server-clock";
import { useGameStore } from "@/stores/game.store";
import type { AnswerResult, Game, LeaderboardEntry, Room, User } from "@/types/game";


const AdventureScene = dynamic(() => import("@/game/AdventureScene"), { ssr: false, loading: () => <div className="scene-loading"><Mountain size={36} /><span>Menyiapkan pulau petualangan...</span></div> });
// The student-facing shell stays focused on one job: start and guide a class game.
// Progress, coins, and personal profiles remain server data for compatibility but
// are intentionally not surfaced in the classroom UI.
const navItems = [{ id: "adventure", name: "Papan belajar", icon: Compass }, { id: "leaderboard", name: "Peringkat kelas", icon: Trophy }];
const previewPlayers = [
  { id: "demo-raka", username: "Raka", position: 1 },
  { id: "demo-nara", username: "Nara", position: 4 },
  { id: "demo-bima", username: "Bima", position: 8 },
  { id: "demo-lila", username: "Lila", position: 10 },
];
const previewBoard = {
  snakes: { "17": 7, "54": 34, "62": 19, "87": 24, "93": 73, "98": 79 },
  ladders: { "3": 22, "8": 30, "20": 41, "28": 55, "50": 69, "71": 92 },
};

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="scene-loading"><Mountain size={48} /><h3>Pulau 3D belum dapat ditampilkan</h3><p>Aktifkan akselerasi grafis atau gunakan browser yang mendukung WebGL.</p><button className="button secondary" onClick={() => this.setState({ failed: false })}>Coba lagi</button></div> : this.props.children; }
}

function Avatar({ name, index = 0, small = false }: { name: string; index?: number; small?: boolean }) {
  return <span className={`avatar avatar-${index % 4}${small ? " small" : ""}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} className="modal"><div className="modal-head"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Tutup dialog" onClick={onClose}><X size={20} /></button></div>{children}</dialog>;
}

export default function AdventureApp({ initialCode, initialGameId }: { initialCode?: string; initialGameId?: string }) {
  const { user, room, game, result, diceRoll, connection, setUser, setRoom, setGame, setResult } = useGameStore();
  const [fullscreen, setFullscreen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shellRef.current?.requestFullscreen();
    } catch { setNotice("Gunakan tombol layar penuh pada browser untuk memperluas permainan."); }
  }
  const [tab, setTab] = useState("adventure");
  const [modal, setModal] = useState<"login" | "join" | "local" | "help" | "settings" | null>(null);
  const [username, setUsername] = useState("");
  const [localNames, setLocalNames] = useState<string[]>([""]);
  const [code, setCode] = useState(initialCode || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [intent, setIntent] = useState<"create" | "quick" | "join" | "local" | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [quality, setQuality] = useState<"low" | "high">("high");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [focusPlayer, setFocusPlayer] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const [publicRooms, setPublicRooms] = useState<Room[]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [routeCode, setRouteCode] = useState(initialCode || "");
  const [routeGameId, setRouteGameId] = useState(initialGameId || "");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const current = game?.players.find((p) => p.id === game.currentPlayerId);
  const isMyTurn = !!user && game?.currentPlayerId === user.id;
  const isLocal = room?.mode === "local";
  // In a single-device room the screen controls every local player, so the
  // device may act whenever a game is running; the server still validates turns.
  const canAct = isLocal ? !!current : isMyTurn;
  const remaining = game?.deadline ? Math.max(0, Math.ceil((Date.parse(game.deadline) - now) / 1000)) : 30;
  const players = game?.players || room?.players || [];
  const localNamesReady = localNames.length >= 1 && localNames.every((name) => name.trim().length >= 2);

  const refreshLeaderboard = useCallback(async () => {
    const entries = await api<LeaderboardEntry[]>("/leaderboard");
    setLeaderboard(Array.isArray(entries) ? entries : []);
    setError("");
  }, []);

  useEffect(() => {
    if (tab !== "leaderboard" || !user) return;
    let active = true;
    const refresh = () => refreshLeaderboard().catch((e) => { if (active) setError(e instanceof Error ? e.message : "Peringkat belum dapat dimuat."); });
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [tab, user?.id, refreshLeaderboard]);

  useEffect(() => {
    if (!user) return;
    void refreshLeaderboard().catch(() => {});
  }, [user?.id, game?.id, game?.status, game?.turnState, game?.turnNumber, connection, refreshLeaderboard]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Terjadi kesalahan. Coba lagi."); }
    finally { setBusy(false); }
  }

  function acceptRoom(next: Room) {
    setRoom(next); sessionStorage.setItem("adventure-room", next.code);
    setRouteCode(next.code); setRouteGameId("");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/room/${encodeURIComponent(next.code)}`);
  }

  useEffect(() => {
    const readRoute = () => {
      const match = window.location.hash.match(/^#\/(room|game)\/([^/?#]+)/);
      setRouteCode(match?.[1] === "room" ? decodeURIComponent(match[2]) : "");
      if (match?.[1] === "room") setCode(decodeURIComponent(match[2]));
      setRouteGameId(match?.[1] === "game" ? decodeURIComponent(match[2]) : "");
    };
    readRoute(); window.addEventListener("hashchange", readRoute);
    return () => window.removeEventListener("hashchange", readRoute);
  }, []);

  useEffect(() => {
    try {
      const savedQuality = readStoredSetting("adventure-quality", "quality", localStorage);
      setQuality(resolveQuality(savedQuality, window.innerWidth));
    } catch {
      setQuality(resolveQuality(null, window.innerWidth));
    }
    try {
      const savedMotion = readStoredSetting("adventure-reduced-motion", "reduced-motion", localStorage);
      setReducedMotion(resolveReducedMotion(savedMotion, window.matchMedia("(prefers-reduced-motion: reduce)").matches));
    } catch {
      setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
    setHydrated(true);
    let cancelled = false;
    async function restore() {
      try {
        // This only checks the old HTTP-only cookie on an explicitly configured
        // local preview. The returned opaque token is then validated by Supabase.
        await claimLocalMigrationSession();
        if (cancelled) return;
        const me = await api<User>("/auth/me");
        if (cancelled) return;
        setUser(me);
        const fragmentRoute = window.location.hash.match(/^#\/(room|game)\/([^/?#]+)/);
        const activeGameId = initialGameId || (fragmentRoute?.[1] === "game" ? decodeURIComponent(fragmentRoute[2]) : "");
        const activeCode = initialCode || (fragmentRoute?.[1] === "room" ? decodeURIComponent(fragmentRoute[2]) : "");
        if (activeCode) {
          setCode(activeCode);
          setIntent("join");
          setModal("join");
          return;
        }
        if (activeGameId) {
          const savedGame = await api<Game>(`/games/${activeGameId}/state`);
          const savedRoom = await api<Room>(`/rooms/${savedGame.roomId}`);
          if (!cancelled) { acceptRoom(savedRoom); setGame(savedGame); }
        } else {
          const saved = sessionStorage.getItem("adventure-room");
          if (saved) {
            try { const next = await api<Room>(`/rooms/${saved}`); if (!cancelled) acceptRoom(next); }
            catch (e) {
              if (!(e instanceof ApiError) || (e.status !== 403 && e.status !== 404)) throw e;
              sessionStorage.removeItem("adventure-room");
            }
          }
          const activeRoom = await api<Room | null>("/rooms/current");
          if (!cancelled && activeRoom) acceptRoom(activeRoom);
        }
      } catch (e) {
        if (!cancelled && e instanceof ApiError && e.status !== 401) setError(e.message);
        if (!cancelled && (initialCode || window.location.hash.startsWith("#/room/"))) { setIntent("join"); setModal("login"); }
      } finally { if (!cancelled) setReady(true); }
    }
    void restore();
    return () => { cancelled = true; };
    // Initial route and session restoration happen only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!room?.id || !user) return;
    return connectGame(room.id, room.gameId);
  }, [room?.id, room?.gameId, user?.id]);

  useEffect(() => {
    if (!room?.gameId) return;
    let cancelled = false;
    api<Game>(`/games/${room.gameId}/state`).then((g) => { if (!cancelled) setGame(g); }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [room?.gameId, setGame]);

  // Realtime stays primary; polling only rescues a client whose WebSocket cannot
  // connect, so turns and positions still arrive within seconds.
  useEffect(() => {
    if (!room?.gameId || connection === "connected") return;
    const gameId = room.gameId;
    const interval = setInterval(() => {
      const state = useGameStore.getState();
      if (state.game?.id !== gameId) return;
      const roll = state.diceRoll;
      if (roll && Date.now() - roll.startedAt < DICE_ROLL_DURATION_MS) return;
      api<Game>(`/games/${gameId}/state`).then((g) => {
        if (useGameStore.getState().game?.id === gameId) setGame(g);
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [room?.gameId, connection, setGame]);

  useEffect(() => { setSelected(null); }, [game?.question?.id, game?.turnNumber]);
  useEffect(() => {
    if (!game || game.status === "finished") return;
    const timer = setInterval(() => setNow(serverNow()), 250);
    return () => clearInterval(timer);
  }, [game?.id, game?.status]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
   }, [notice]);
  useEffect(() => { if (!hydrated) return; try { localStorage.setItem("adventure-quality", quality); } catch {} }, [quality, hydrated]);
  useEffect(() => { if (!hydrated) return; try { localStorage.setItem("adventure-reduced-motion", String(reducedMotion)); } catch {} }, [reducedMotion, hydrated]);

  async function startIntent(action: "create" | "quick" | "join" | "local") {
    if (!user) { setIntent(action); setModal("login"); return; }
    if (action === "join") { setModal("join"); return; }
    if (action === "local") { setLocalNames([""]); setError(""); setModal("local"); return; }
    await perform(async () => {
      const next = await api<Room>(action === "quick" ? "/rooms/quick" : "/rooms", { isPublic });
      acceptRoom(next); setGame(null); setResult(null);
    });
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      const me = await api<User>("/auth/guest", { username: username.trim() });
      setUser(me);
      if (me.username !== username.trim()) {
        setNotice(`Browser ini sudah masuk sebagai ${me.username}. Untuk pemain lain di komputer yang sama, gunakan mode Main satu perangkat.`);
      }
      if (intent === "join") {
        if (routeCode) {
          const next = await api<Room>(`/rooms/${encodeURIComponent(routeCode.trim().toUpperCase())}/join`, {});
          acceptRoom(next); setGame(null); setResult(null);
          setModal(null); setIntent(null);
          return;
        }
        setModal("join"); return;
      }
      if (intent === "local") { setLocalNames([""]); setModal("local"); return; }
      if (intent) {
        const next = await api<Room>(intent === "quick" ? "/rooms/quick" : "/rooms", { isPublic });
        acceptRoom(next); setGame(null); setResult(null);
      }
      setModal(null); setIntent(null);
    });
  }

  async function rollDice() {
    if (!game) return;
    await perform(async () => {
      const response = await api<{ dice: number }>(`/games/${game.id}/dice/roll`, isLocal ? { playerId: game.currentPlayerId } : {});
      const state = useGameStore.getState();
      if (state.connection !== "connected" && state.game?.id === game.id) {
        state.setDiceRoll({ id: requestId(), value: response.dice, startedAt: Date.now() });
        state.setGame({ ...state.game, turnState: "MOVING", diceResult: response.dice });
      }
    });
  }

  async function createLocal(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      const next = await api<Room>("/rooms/local", { players: localNames.map((name) => name.trim()) });
      acceptRoom(next); setGame(null); setResult(null);
      setModal(null); setIntent(null);
    });
  }

  async function join(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      const next = await api<Room>(`/rooms/${encodeURIComponent(code.trim().toUpperCase())}/join`, {});
      acceptRoom(next); setModal(null); setResult(null);
    });
  }

  async function leave() {
    await perform(async () => {
      if (room) await api(`/rooms/${room.id}/leave`, {});
      setRoom(null); setGame(null); setResult(null); sessionStorage.removeItem("adventure-room");
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    });
  }

  function openTab(id: string) {
    setTab(id); setError("");
  }

  async function copyInvite() {
    if (!room) return;
    try { await navigator.clipboard.writeText(`${location.origin}${location.pathname}#/room/${encodeURIComponent(room.code)}`); setNotice("Tautan undangan disalin."); }
    catch { setNotice(`Kode undangan: ${room.code}`); }
  }

  // In local mode every player acts from this screen, so feedback from any
  // local player stays visible (the explanation is part of the fun).
  const myResult = result && (isLocal
    ? (room?.players || []).some((p) => p.id === result.playerId)
    : !result.playerId || result.playerId === user?.id) ? result : null;

  return <div ref={shellRef} className={`app-shell island-shell ${tab === "adventure" ? "is-adventure" : ""}`}>
    <aside className="sidebar">
      <a className="brand" href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`} aria-label="Ular Tangga Adventure beranda"><span className="brand-symbol"><Dice5 size={29} strokeWidth={2.4} /><Leaf className="brand-leaf" size={17} /></span><span>ular tangga<span className="brand-sub">ADVENTURE</span></span></a>
      <div className="nav-caption">RUANG KELAS</div>
      <nav aria-label="Navigasi utama">{navItems.map(({ id, name, icon: Icon }) => <button key={id} onClick={() => void openTab(id)} className={`nav-item ${tab === id ? "active" : ""}`} aria-current={tab === id ? "page" : undefined} aria-label={name}><Icon size={20} /><span>{name}</span>{tab === id && <span className="active-dot" />}</button>)}<button onClick={() => setModal("settings")} className="nav-item nav-icon-only" aria-label="Pengaturan"><Settings2 size={20} /><span>Pengaturan</span></button><button onClick={() => setModal("help")} className="nav-item nav-icon-only" aria-label="Panduan bermain"><CircleHelp size={20} /><span>Panduan bermain</span></button><a href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/admin/`} className="nav-item nav-icon-only" aria-label="Kelola bank soal"><ShieldCheck size={20} /><span>Kelola bank soal</span></a></nav>
      <div className="field-note"><span className="note-icon"><BookOpen size={23} /></span><h3>Satu papan,<br />banyak pelajaran.</h3><p>Guru memandu kelas. Anak belajar sambil bermain.</p><button onClick={() => setModal("help")}>Lihat panduan <ArrowRight size={15} /></button><span className="note-leaf"><Leaf size={63} /></span></div>
      <div className="sidebar-bottom"><div className="sidebar-footer"><span className="status-dot" /> Belajar. Bermain. Bertualang.</div></div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><span>Ruang kelas</span><ChevronRight size={14} /><strong>{navItems.find((n) => n.id === tab)?.name}</strong></div><div className="topbar-player"><button className="fullscreen-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Keluar layar penuh" : "Layar penuh"}><Maximize2 size={17} /><span>{fullscreen ? "Perkecil" : "Layar penuh"}</span></button><span className="teacher-mode"><BookOpen size={17} /> Mode guru</span></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span /> MEDIA BELAJAR INTERAKTIF</div><h1>{tab === "adventure" ? "Papan belajar siap dimainkan" : navItems.find((n) => n.id === tab)?.name}</h1><p>{tab === "adventure" ? "Pandu kelas menjawab soal, lalu lihat konsepnya bergerak di papan." : "Siapkan permainan belajar untuk kelasmu."}</p></div><button className="guide-button" onClick={() => setModal("help")}><BookOpen size={17} /> Panduan guru <ArrowUpRight size={15} /></button></div>
        {error && <div className="alert error" role="alert"><CircleHelp size={18} /><span>{error}</span><button aria-label="Tutup pesan kesalahan" onClick={() => setError("")}><X size={16} /></button></div>}
        {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}

        {tab === "adventure" ? <>
          <div className="adventure-layout">
            <section className="map-card" aria-label="Papan petualangan Pulau Rimba">
              <div className="map-heading"><div><div className="map-eyebrow"><span className="map-number">01</span> PULAU PENGETAHUAN</div><h2>Ular Tangga<span className="title-star"> ✦</span></h2><p>Petak demi petak, menuju kemenangan.</p></div><span className="map-tag"><Leaf size={13} /> Hutan tropis</span></div>
              <div className="scene-container"><SceneBoundary><AdventureScene key={sceneKey} players={players.length ? players : previewPlayers} currentPlayerId={game?.currentPlayerId} totalSteps={game?.totalSteps || 100} snakes={game?.snakes ?? previewBoard.snakes} ladders={game?.ladders ?? previewBoard.ladders} diceRoll={diceRoll} diceValue={game?.diceResult ?? 0} quality={quality} reducedMotion={reducedMotion} focusPlayer={focusPlayer} /></SceneBoundary></div>
              <div className="board-toolbar"><div className="map-caption"><span className="live-dot" />{game ? `Giliran ${game.turnNumber} · ${current?.username || "Penjelajah"}` : "Jelajahi papan · 100 petak kejutan"}</div><p className="scene-help">Seret untuk melihat · Gulir / cubit untuk zoom</p><div className="scene-controls"><button className={`icon-button ${focusPlayer ? "selected" : ""}`} aria-label="Ikuti pemain aktif" aria-pressed={focusPlayer} onClick={() => setFocusPlayer(!focusPlayer)}><Maximize2 size={17} /></button><button className="icon-button" aria-label="Kembalikan sudut kamera" onClick={() => { setSceneKey(sceneKey + 1); setFocusPlayer(false); }}><RotateCcw size={17} /></button></div></div>
              <div className="map-footer"><span><Flag size={15} /><strong>{game?.totalSteps || 100}</strong> langkah petualangan</span><span><Users size={15} /><strong>2–4</strong> pemain</span><span><Mountain size={15} />Jalur penuh kejutan</span></div>
            </section>

            <aside className="play-panel">
              {!room ? <><div className="panel-kicker"><span className="tiny-spark"><Sparkles size={17} /></span> LEBIH SERU BERSAMA</div><h2>Ayo, mulai<br />petualanganmu.</h2><p className="panel-description">Ajak teman atau temukan penjelajah baru. Siapa yang tiba di puncak duluan?</p><button disabled={busy || !ready} className="button primary quick-button" onClick={() => void startIntent("quick")}><Zap size={19} fill="currentColor" />{busy ? "Menghubungkan..." : "Main cepat"}<ArrowRight size={19} /></button><span className="button-caption">Bergabung dengan ruang publik</span><div className="or-divider"><span>atau main dengan teman</span></div><button disabled={busy || !ready} className="button secondary full" onClick={() => void startIntent("create")}><Plus size={19} />Buat ruang</button>              <label className="check-label"><input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />Ruang terbuka untuk semua pemain</label><button disabled={busy || !ready} className="join-button" onClick={() => void startIntent("join")}>Punya kode ruang? <strong>Gabung <ArrowRight size={14} /></strong></button><div className="or-divider"><span>bermain tanpa perangkat lain</span></div><button disabled={busy || !ready} className="join-button local-join" onClick={() => void startIntent("local")}><Smartphone size={20} />Main satu perangkat <strong>2–4 pemain, satu layar <ArrowRight size={14} /></strong></button><div className="panel-rule"><ShieldCheck size={22} /><span>Jawaban salah? Tidak apa-apa.<br /><strong>Posisimu tetap, coba di giliran berikutnya.</strong></span></div></> : !game ? <>{isLocal ? <><div className="panel-kicker"><Smartphone size={17} /> MODE SATU PERANGKAT</div><div className="room-code local"><div><span>SEMUA PEMAIN DI LAYAR INI</span><h2>Bergantian main</h2></div></div><p className="panel-description">Semua pemain menjawab pertanyaan dan melempar dadu bergantian di perangkat ini. Tidak perlu perangkat lain.</p><div className="room-players">{room.players.map((player, i) => <div className="room-player" key={player.id}><Avatar name={player.username} index={i} small /><strong>{player.username}</strong>{player.id === room.hostId ? <Crown size={16} /> : <span className="status-dot" />}</div>)}</div><button className="button primary full" disabled={busy || room.players.length < 2 || user?.id !== room.hostId} onClick={() => void perform(async () => { const next = await api<Game>(`/rooms/${room.id}/start`, {}); setGame(next); })}><Flag size={18} />Mulai petualangan</button><button className="subtle-button" disabled={busy} onClick={() => void leave()}><LogOut size={15} />Keluar dari ruang</button></> : <><div className="panel-kicker"><Users size={17} /> RUANG PETUALANGAN</div><div className="room-code"><div><span>KODE RUANG</span><h2>{room.code}</h2></div><button className="icon-button" onClick={() => void copyInvite()} aria-label="Salin tautan undangan"><Copy size={20} /></button></div><p className="panel-description">Bagikan kode dan ajak temanmu masuk. Petualangan dimulai dengan 2–4 pemain.</p><div className="room-players">{room.players.map((player, i) => <div className="room-player" key={player.id}><Avatar name={player.username} index={i} small /><strong>{player.username}</strong>{player.id === room.hostId ? <Crown size={16} /> : <span className="status-dot" />}</div>)}{Array.from({ length: Math.max(0, 4 - room.players.length) }, (_, i) => <div className="empty-player" key={i}><Plus size={16} />Menunggu penjelajah...</div>)}</div><button className="button primary full" disabled={busy || room.players.length < 2 || user?.id !== room.hostId} onClick={() => void perform(async () => { const next = await api<Game>(`/rooms/${room.id}/start`, {}); setGame(next); })}><Flag size={18} />{user?.id === room.hostId ? "Mulai petualangan" : "Menunggu pemilik ruang"}</button><button className="subtle-button" disabled={busy} onClick={() => void leave()}><LogOut size={15} />Keluar dari ruang</button></>}</> : game.status === "finished" ? <div className="victory"><span className="victory-icon"><Trophy size={44} /></span><div className="panel-kicker">PUNCAK TERCAPAI</div><h2>{game.players.find((p) => p.id === game.winnerId)?.username} menang!</h2><p>Perjalanan selesai. Pengetahuan yang kamu temukan tetap bersamamu.</p><div className="results-list">{[...game.players].sort((a, b) => b.position - a.position).map((p, i) => <div key={p.id}><span>{i + 1}. {p.username}</span><strong>{p.position} / {game.totalSteps}</strong></div>)}</div><button disabled={busy} className="button primary full" onClick={() => void leave()}>Kembali ke lobi <ArrowRight size={17} /></button></div> : <>
                <div className="turn-header"><span className="panel-kicker">GILIRAN {game.turnNumber}</span><span className={`connection ${connection}`} title={connection}>{connection === "connected" ? <Wifi size={15} /> : <WifiOff size={15} />}{connection === "connected" ? "Terhubung" : "Menyambungkan"}</span></div>
                <div className="turn-player"><Avatar name={current?.username || "?"} index={game.players.findIndex((p) => p.id === current?.id)} small /><div><h3>{isMyTurn || (isLocal && current?.id === user?.id) ? "Sekarang giliranmu!" : `Giliran ${current?.username}`}</h3><span>Posisi {current?.position || 0} dari {game.totalSteps}</span></div></div>
                {isLocal && current && current.id !== user?.id && <div className="pass-hint" role="status"><Smartphone size={15} /><span>Serahkan perangkat ke <strong>{current.username}</strong> untuk menjawab dan melempar dadu.</span></div>}
                {myResult && <div className={`answer-feedback ${myResult.result === "correct" ? "correct" : "incorrect"}`} role="status"><strong>{myResult.result === "correct" ? "Jawaban benar! Dadumu terbuka." : myResult.result === "timeout" ? "Waktu habis. Posisi tetap." : `Belum tepat. Posisi tetap ${myResult.position}.`}</strong>{myResult.explanation && <p>{myResult.explanation}</p>}</div>}
                {game.turnState === "QUESTION" && game.question ? <><div className="question-meta"><span>{game.question.category || "Pengetahuan umum"}</span><span className={remaining <= 10 ? "timer urgent" : "timer"}><Timer size={15} />{remaining} dtk</span></div><h3 className="question-text">{game.question.question}</h3><div className="answer-options">{game.question.options.map((option, index) => <button disabled={!canAct || busy || remaining <= 0} key={index} className={`answer-option ${selected === index ? "chosen" : ""}`} onClick={() => setSelected(index)} aria-pressed={selected === index}><span>{String.fromCharCode(65 + index)}</span>{option}{selected === index && <Check size={16} />}</button>)}</div><button disabled={!canAct || selected === null || busy || remaining <= 0} className="button primary full" onClick={() => void perform(async () => { const gameId = game.id; const answerResult = await api<AnswerResult>(`/games/${gameId}/question/answer`, { questionId: game.question!.id, answer: selected, ...(isLocal ? { playerId: game.currentPlayerId } : {}) }); setResult({ ...answerResult, playerId: isLocal ? game.currentPlayerId : user!.id }); const state = useGameStore.getState(); if (state.connection !== "connected" && state.game?.id === gameId) { const fresh = await api<Game>(`/games/${gameId}/state`); if (useGameStore.getState().game?.id === gameId) setGame(fresh); } })}>{busy ? "Memeriksa jawaban..." : canAct ? "Kunci jawaban" : "Menunggu jawaban..."}<LockKeyhole size={15} /></button></> : game.turnState === "DICE_UNLOCKED" ? <div className="dice-panel"><Dice5 size={66} strokeWidth={1.5} /><h3>Pengetahuan membuka jalan.</h3><p>{canAct ? (isLocal && current && current.id !== user?.id ? `Dadu ${current.username} sudah terbuka. Lempar sekarang!` : "Dadumu sudah terbuka. Tentukan langkah berikutnya!") : "Menunggu pemain melempar dadu."}</p><button disabled={!canAct || busy} className="button primary full" onClick={() => void rollDice()}><Dice5 size={19} />{busy ? "Melempar..." : "Lempar dadu"}</button></div> : <div className="dice-panel"><Dice5 size={64} /><h2>{diceRoll && now - diceRoll.startedAt < DICE_ROLL_DURATION_MS ? "…" : game.diceResult || "…"}</h2><p>{diceRoll && now - diceRoll.startedAt < DICE_RELEASE_MS ? "Kocok dulu… berapa langkah kali ini?" : diceRoll && now - diceRoll.startedAt < DICE_ROLL_DURATION_MS ? "Tunggu sampai dadunya berhenti…" : "Menjelajahi jalur berikutnya..."}</p></div>}
                {isLocal ? <span className="subtle-button static"><Smartphone size={14} />Mode satu perangkat · {room.code}</span> : <button className="subtle-button" disabled={busy} onClick={() => void copyInvite()}><Copy size={14} />Ruang {room.code}</button>}
              </>}
            </aside>
          </div>

          {game && <section className="players-strip" aria-label="Posisi pemain">{game.players.map((p, i) => <div key={p.id} className={`player-progress ${p.id === game.currentPlayerId ? "current" : ""}`}><Avatar name={p.username} index={i} small /><div><strong>{p.username}{p.id === user?.id ? " (kamu)" : ""}</strong><span>Langkah {p.position} / {game.totalSteps}</span><progress value={p.position} max={game.totalSteps} aria-label={`Kemajuan ${p.username}`} /></div>{p.id === game.currentPlayerId && <Flag size={15} />}</div>)}</section>}
          {game && <section className="class-scoreboard"><div className="section-label"><span className="eyebrow">SELURUH PERMAINAN</span><h2>Peringkat pemain</h2></div><Leaderboard entries={leaderboard.filter((entry) => game.players.some((player) => player.id === entry.id))} sharedFirst={leaderboard.filter((entry) => entry.rank === 1 && entry.correctAnswers > 0).length > 1} compact /></section>}

          <section className="journey-guide"><div className="section-label"><span className="eyebrow">SATU JAWABAN, BANYAK KEMUNGKINAN</span><h2>Begini petualanganmu berjalan</h2></div><div className="journey-steps"><div className="journey-step"><span className="step-icon green"><BookOpen size={22} /></span><div><h3>Jawab tantangan</h3><p>Uji pengetahuanmu di setiap giliran.</p></div></div><ChevronRight className="step-arrow" size={18} /><div className="journey-step"><span className="step-icon yellow"><Dice5 size={23} /></span><div><h3>Buka & lempar dadu</h3><p>Jawaban benar membuka langkahmu.</p></div></div><ChevronRight className="step-arrow" size={18} /><div className="journey-step"><span className="step-icon peach"><Flag size={22} /></span><div><h3>Temukan kejutan</h3><p>Seberangi jembatan. Waspadai ular!</p></div></div></div></section>
          <div className="bottom-row"><div className="expedition-note"><span className="expedition-icon"><Leaf size={23} /></span><div><h3>Bukan sekadar sampai di puncak.</h3><p>Ini tentang hal-hal baru yang kamu pelajari di perjalanan.</p></div><span className="handdrawn-arrow"><ArrowUpRight size={35} /></span></div><button className="public-rooms-toggle" disabled={busy} onClick={() => void perform(async () => { const rooms = await api<Room[]>("/rooms"); setPublicRooms(rooms || []); setDirectoryLoaded(true); })}><Users size={18} /><span>Temukan teman bermain<strong>Lihat ruang publik <ArrowRight size={15} /></strong></span></button></div>
          {directoryLoaded && <section className="directory"><h2>Ruang publik</h2>{publicRooms.length ? publicRooms.map((r) => <div key={r.id}><strong>{r.code}</strong><span>{r.players.length}/4 pemain</span><button disabled={busy || !!room} className="button small-button secondary" onClick={() => { setCode(r.code); void startIntent("join"); }}>Gabung <ArrowRight size={15} /></button></div>) : <p>Belum ada ruang publik. Buat ruang terbuka untuk mengajak penjelajah lain.</p>}</section>}
        </> : <section className="account-page">
          {!user ? <div className="empty-state"><Trophy size={42} /><h2>Masuk untuk melihat peringkat.</h2><p>Nama dan jawaban benar siswa tampil bersama seluruh permainan kelas.</p><button className="button primary" onClick={() => { setIntent(null); setModal("login"); }}>Mulai sesi kelas <ArrowRight size={17} /></button></div> : <>
            <div className="leaderboard-head"><div><h2>Jawaban benar terbanyak</h2><p>Akumulasi dari seluruh permainan. Nama yang sama pada perangkat guru yang sama menyimpan progres; nama yang diganti dihitung sebagai siswa berbeda.</p></div><span className="map-tag">Semua permainan</span></div>
            <Leaderboard entries={leaderboard} />
          </>}
        </section>}
        <footer className="page-footer"><span>ULAR TANGGA <strong>ADVENTURE</strong></span><span>Dibuat untuk rasa ingin tahu.<Leaf size={13} /></span></footer>
      </main>
    </div>

    {modal === "login" && <Modal title="Mulai sesi kelas" onClose={() => setModal(null)}><p>Masukkan nama pengajar atau kelas. Tidak perlu email untuk menyiapkan permainan.</p><form onSubmit={(e) => void login(e)}><label className="field-label" htmlFor="username">Nama pengajar / kelas</label><input id="username" autoFocus minLength={2} maxLength={20} required placeholder="Contoh: Bu Rina" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="nickname" />{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || username.trim().length < 2}>{busy ? "Menyiapkan sesi..." : "Mulai sesi kelas"}<ArrowRight size={18} /></button><p className="privacy-note"><ShieldCheck size={15} />Sesi ini tersimpan di browser agar ruang kelas bisa dilanjutkan.</p></form></Modal>}
    {modal === "join" && <Modal title="Temanmu sudah menunggu." onClose={() => setModal(null)}><p>Masukkan kode ruang yang dibagikan temanmu.</p><form onSubmit={(e) => void join(e)}><label className="field-label" htmlFor="room-code">Kode ruang</label><input id="room-code" className="code-input" autoFocus required maxLength={8} minLength={5} placeholder="A7K29" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || code.length < 5}>{busy ? "Bergabung..." : "Gabung petualangan"}<ArrowRight size={18} /></button></form></Modal>}
    {modal === "local" && <Modal title="Satu perangkat, banyak penjelajah." onClose={() => setModal(null)}><p>Isi nama teman yang bermain bersamamu. Kalian bergantian menjawab pertanyaan dan melempar dadu di layar yang sama — tanpa perangkat lain.</p><form onSubmit={(e) => void createLocal(e)}><label className="field-label" htmlFor="local-host">Pemain 1 · kamu</label><input id="local-host" value={user?.username || ""} disabled autoComplete="off" />{localNames.map((name, i) => <div className="local-player-row" key={i}><div><label className="field-label" htmlFor={`local-name-${i}`}>Pemain {i + 2}</label><input id={`local-name-${i}`} autoFocus={i === 0} required minLength={2} maxLength={24} placeholder={["Contoh: Nara", "Contoh: Bima", "Contoh: Lila"][i] || "Nama pemain"} value={name} onChange={(e) => setLocalNames(localNames.map((value, j) => j === i ? e.target.value : value))} autoComplete="off" /></div>{localNames.length > 1 && <button type="button" className="icon-button" aria-label={`Hapus pemain ${i + 2}`} onClick={() => setLocalNames(localNames.filter((_, j) => j !== i))}><X size={16} /></button>}</div>)}{localNames.length < 3 && <button type="button" className="button secondary full add-player" disabled={busy} onClick={() => setLocalNames([...localNames, ""])}><Plus size={16} />Tambah pemain ({localNames.length + 2} dari 4)</button>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || !localNamesReady}>{busy ? "Menyiapkan ruang..." : `Mulai dengan ${localNames.length + 1} pemain`}<ArrowRight size={18} /></button><p className="privacy-note"><Smartphone size={15} />Pemain tambahan bermain dari perangkatmu.</p></form></Modal>}
    {modal === "help" && <Modal title="Panduan guru" onClose={() => setModal(null)}><div className="help-list"><div><BookOpen /><section><h3>Satu giliran, satu pertanyaan</h3><p>Berikan waktu 30 detik untuk memilih jawaban. Pertanyaan dijawab bergantian.</p></section></div><div><Dice5 /><section><h3>Jawaban benar membuka dadu</h3><p>Lempar dadu untuk menggerakkan pemain dan menghubungkan soal dengan perjalanan di papan.</p></section></div><div><ShieldCheck /><section><h3>Jawaban salah tetap aman</h3><p>Posisi pemain tetap dan giliran beralih. Gunakan penjelasan soal untuk membahas jawabannya bersama kelas.</p></section></div><div><Smartphone /><section><h3>Main di satu perangkat</h3><p>Pilih "Main satu perangkat", isi nama 2–4 pemain, lalu serahkan layar bergantian. Tidak perlu perangkat lain.</p></section></div><div><ArrowUpRight /><section><h3>Jembatan dan ular menguatkan konsep</h3><p>Jembatan membawa pemain maju, ular membawa pemain mundur. Capai posisi 100 untuk menyelesaikan permainan.</p></section></div></div><button className="button primary full" onClick={() => setModal(null)}>Siap mengajar <ArrowRight size={17} /></button></Modal>}
    {modal === "settings" && <Modal title="Atur petualanganmu" onClose={() => setModal(null)}><label className="field-label" htmlFor="quality">Kualitas dunia 3D</label><select id="quality" value={quality} onChange={(e) => setQuality(e.target.value as "low" | "high")}><option value="high">Tinggi · desktop</option><option value="low">Ringan · mobile</option></select><label className="setting-check"><input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} /><span><strong>Kurangi animasi</strong><small>Gerakan lebih sederhana, aturan tetap sama.</small></span></label><p className="privacy-note">Audio belum diaktifkan pada versi ini.</p><button className="button primary full" onClick={() => setModal(null)}>Terapkan pengaturan <Check size={17} /></button></Modal>}
  </div>;
}

function Leaderboard({ entries, compact = false, sharedFirst: sharedFirstOverride }: { entries: LeaderboardEntry[]; compact?: boolean; sharedFirst?: boolean }) {
  if (!entries.length) return <div className="empty-state"><Trophy size={40} /><h3>Belum ada penjelajah di papan peringkat.</h3><p>Mulai permainan kelas untuk mencatat jawaban benar pertama.</p></div>;
  const sharedFirst = sharedFirstOverride ?? entries.filter((entry) => entry.rank === 1 && entry.correctAnswers > 0).length > 1;
  return <div className={`leaderboard-list${compact ? " compact" : ""}`} aria-label="Peringkat jawaban benar seluruh permainan">{entries.map((entry, i) => {
    const champion = entry.rank === 1 && entry.correctAnswers > 0;
    return <div key={entry.id} className={champion ? "leaderboard-champion" : ""}><span className="rank">{entry.rank}</span><Avatar name={entry.username} index={i} small /><strong>{entry.username}</strong>{champion && <span className="leaderboard-badge"><Crown size={14} />{sharedFirst ? "Juara bersama" : compact ? "Juara" : "Juara kelas"}</span>}<b>{entry.correctAnswers} jawaban benar</b></div>;
  })}{!compact && <p className="muted">Semua penjelajah ditampilkan, termasuk yang belum mendapat jawaban benar.</p>}</div>;
}
