"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState, useId, type ReactNode, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight, CircleHelp, Compass, Copy, Crown, Dice5, Flag, Leaf, LockKeyhole, LogOut, Maximize2, Minimize2, Mountain, Plus, RotateCcw, Settings2, ShieldCheck, Smartphone, Sparkles, Timer, Trophy, Users, Wifi, WifiOff, X, Zap } from "lucide-react";
import { api, ApiError, claimLocalMigrationSession, clearSessionTokens, getSessionToken, requestId } from "@/services/api";
import { createTeacherGameSession } from "@/services/admin";
import { clearTeacherActorId, getTeacherActorId, getTeacherSession, setTeacherActorId, signOutTeacher, supabaseAuth } from "@/services/supabase-auth";
import { shouldReconcileAuthIdentity } from "@/services/auth-transition";
import { rankRoster } from "@/services/rank-roster";
import { readStoredSetting, resolveQuality, resolveReducedMotion } from "@/services/settings";
import { DICE_RELEASE_MS, DICE_ROLL_DURATION_MS } from "@/game/dice-motion";
import { connectGame } from "@/services/websocket";
import { createVisiblePoller } from "@/services/visible-poller";
import { createGameStateFallbackPoller } from "@/services/game-state-fallback";
import { serverNow } from "@/services/server-clock";
import { useGameStore } from "@/stores/game.store";
import type { AnswerResult, Game, LeaderboardEntry, Room, User } from "@/types/game";


const AdventureScene = dynamic(() => import("@/game/AdventureScene"), { ssr: false, loading: () => <div className="scene-loading"><Mountain size={36} /><span>Menyiapkan pulau petualangan...</span></div> });
// The student-facing shell stays focused on one job: start and guide a class game.
// Progress, coins, and personal profiles remain server data for compatibility but
// are intentionally not surfaced in the classroom UI.
const navItems = [{ id: "adventure", name: "Papan belajar", icon: Compass }, { id: "leaderboard", name: "Peringkat", icon: Trophy }];
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

function Modal({ title, children, onClose, restoreFocus = true }: { title: string; children: ReactNode; onClose: () => void; restoreFocus?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!openerRef.current) openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    const initialFocus = dialog?.querySelector<HTMLElement>("[data-modal-focus]")
      ?? dialog?.querySelector<HTMLElement>("input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled])")
      ?? dialog?.querySelector<HTMLElement>(".modal-actions .button.secondary")
      ?? dialog?.querySelector<HTMLElement>(".modal-head button");
    initialFocus?.focus({ preventScroll: true });
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const closeFromDialog = () => {
    onClose();
    if (restoreFocus) requestAnimationFrame(() => {
      if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
    });
  };
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); closeFromDialog(); }} onClick={(e) => { if (e.target === e.currentTarget) closeFromDialog(); }} className="modal"><div className="modal-head"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Tutup dialog" onClick={closeFromDialog}><X size={20} /></button></div>{children}</dialog>;
}

export default function AdventureApp({ initialCode, initialGameId }: { initialCode?: string; initialGameId?: string }) {
  const { user, room, game, result, resultTurnNumber, diceRoll, connection, setUser, setRoom, setGame, setResult, resetGameplay } = useGameStore();
  const teacherOwnerRef = useRef<string | null>(user?.teacherRole === "teacher" ? user.id : null);
  const isRestoringSessionRef = useRef(true);
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
  const [modal, setModal] = useState<"login" | "join" | "local" | "help" | "settings" | "identity" | "exit-session" | "leave-room" | null>(null);
  const [username, setUsername] = useState("");
  const [localNames, setLocalNames] = useState<string[]>(["", ""]);
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
  const [boardExpanded, setBoardExpanded] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [focusPlayer, setFocusPlayer] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const [publicRooms, setPublicRooms] = useState<Room[]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [routeCode, setRouteCode] = useState(initialCode || "");
  const [routeGameId, setRouteGameId] = useState(initialGameId || "");
  const [homeMode, setHomeMode] = useState(false);
  const [resumeRoom, setResumeRoom] = useState<Room | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const current = game?.players.find((p) => p.id === game.currentPlayerId);
  const isMyTurn = !!user && game?.currentPlayerId === user.id;
  const isLocal = room?.mode === "local";
  const sessionRoom = room || resumeRoom;
  const ownerEndsRoom = sessionRoom?.mode === "local" && sessionRoom.hostId === user?.id;
  // In a single-device room the screen controls every local player, so the
  // device may act whenever a game is running; the server still validates turns.
  const canAct = isLocal ? !!current : isMyTurn;
  const remaining = game?.deadline ? Math.max(0, Math.ceil((Date.parse(game.deadline) - serverNow()) / 1000)) : 30;
  const players = game?.players || room?.players || [];
  const localNamesReady = localNames.length >= 2 && localNames.length <= 4 && localNames.every((name) => name.trim().length >= 2);


  useEffect(() => {
    if (tab !== "leaderboard" || !user) return;
    let active = true;
    const stop = createVisiblePoller(async () => {
      try {
        const entries = await api<LeaderboardEntry[]>("/leaderboard");
        if (!active) return null;
        setLeaderboard(Array.isArray(entries) ? entries : []);
        setError("");
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Peringkat belum dapat dimuat.");
      }
      return 5000;
    });
    return () => { active = false; stop(); };
  }, [tab, user?.id]);



  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Terjadi kesalahan. Coba lagi."); }
    finally { setBusy(false); }
  }

  function acceptRoom(next: Room) {
    setHomeMode(false); setResumeRoom(null);
    setRoom(next); sessionStorage.setItem("adventure-room", next.code);
    setRouteCode(next.code); setRouteGameId("");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/room/${encodeURIComponent(next.code)}`);
  }

  useEffect(() => {
    const readRoute = () => {
      const match = window.location.hash.match(/^#\/(room|game)\/([^/?#]+)/);
      setHomeMode(window.location.hash === "#/home");
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
    isRestoringSessionRef.current = true;
    async function restore() {
      try {
        const teacherAuth = await getTeacherSession();
        if (cancelled) return;
        isRestoringSessionRef.current = false;
        if (teacherAuth) {
          const actorChanged = (teacherOwnerRef.current !== null && teacherOwnerRef.current !== teacherAuth.user.id)
            || (!!getTeacherActorId() && getTeacherActorId() !== teacherAuth.user.id);
          teacherOwnerRef.current = teacherAuth.user.id;
          if (actorChanged) {
            clearSessionTokens(); clearTeacherActorId(); sessionStorage.removeItem("adventure-room");
            resetGameplay(); setUser(null); setResumeRoom(null);
          }
          let matchedSession = false;
          if (!actorChanged && getSessionToken()) {
            try {
              const existing = await api<User>("/auth/me");
              if (existing.id === teacherAuth.user.id) { matchedSession = true; teacherOwnerRef.current = teacherAuth.user.id; setUser(existing); setTeacherActorId(teacherAuth.user.id); }
              else { clearSessionTokens(); sessionStorage.removeItem("adventure-room"); resetGameplay(); setUser(null); }
            } catch (error) {
              if (error instanceof ApiError && error.status === 401) { clearSessionTokens(); sessionStorage.removeItem("adventure-room"); resetGameplay(); setUser(null); }
              else throw error;
            }
          }
          if (!matchedSession) {
            const teacher = await createTeacherGameSession();
            if (cancelled) return;
            teacherOwnerRef.current = teacherAuth.user.id;
            setTeacherActorId(teacherAuth.user.id); setUser(teacher);
          }
        }
        // This only checks the old HTTP-only cookie on an explicitly configured
        // local preview. The returned opaque token is then validated by Supabase.
        if (!teacherAuth) await claimLocalMigrationSession();
        if (cancelled) return;
        const me = await api<User>("/auth/me");
        if (cancelled) return;
        setUser(me);
        const fragmentRoute = window.location.hash.match(/^#\/(room|game)\/([^/?#]+)/);
        const isHomeRoute = window.location.hash === "#/home";
        const activeGameId = initialGameId || (fragmentRoute?.[1] === "game" ? decodeURIComponent(fragmentRoute[2]) : "");
        const activeCode = initialCode || (fragmentRoute?.[1] === "room" ? decodeURIComponent(fragmentRoute[2]) : "");
        if (activeCode) {
          const currentRoom = await api<Room | null>("/rooms/current");
          if (cancelled) return;
          if (currentRoom?.code.toUpperCase() === activeCode.trim().toUpperCase()) {
            acceptRoom(currentRoom);
            setGame(null); setResult(null);
            if (currentRoom.gameId) {
              const currentGame = await api<Game>(`/games/${currentRoom.gameId}/state`);
              if (!cancelled) setGame(currentGame);
            }
            return;
          }
          setCode(activeCode);
          setIntent("join");
          setModal("join");
          return;
        }
        if (isHomeRoute) {
          const activeRoom = await api<Room | null>("/rooms/current");
          if (!cancelled) setResumeRoom(activeRoom);
        } else if (activeGameId) {
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
      } finally { if (!cancelled) { isRestoringSessionRef.current = false; setReady(true); } }
    }
    void restore();
    return () => { cancelled = true; };
    // Initial route and session restoration happen only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return;
    const { data } = supabaseAuth().auth.onAuthStateChange((event, session) => {
      const nextId = session?.user.id ?? null;
      const currentUser = useGameStore.getState().user;
      if (shouldReconcileAuthIdentity({
        currentOwnerId: teacherOwnerRef.current,
        nextOwnerId: nextId,
        event,
        hasGuestIdentity: !!currentUser && currentUser.teacherRole !== "teacher",
        isRestoringSession: isRestoringSessionRef.current,
      })) {
        teacherOwnerRef.current = nextId;
        clearSessionTokens(); clearTeacherActorId(); sessionStorage.removeItem("adventure-room");
        resetGameplay(); setUser(null); setResumeRoom(null);
        if (nextId) window.setTimeout(() => window.location.reload(), 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [resetGameplay, setUser]);

  useEffect(() => {
    if (homeMode || !room?.id || !user) return;
    return connectGame(room.id, room.gameId);
  }, [room?.id, room?.gameId, user?.id, homeMode]);

  useEffect(() => {
    if (homeMode || !room?.gameId) return;
    let cancelled = false;
    api<Game>(`/games/${room.gameId}/state`).then((g) => { if (!cancelled) setGame(g); }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [room?.gameId, setGame, homeMode]);

  // A state refresh is a fallback while the sync poller is reconnecting.
  useEffect(() => {
    if (homeMode || !room?.gameId || connection === "connected") return;
    const gameId = room.gameId;
    let active = true;
    const stop = createGameStateFallbackPoller(gameId, {
      isActive: () => active && useGameStore.getState().connection !== "connected",
      getGame: () => useGameStore.getState().game,
      setGame,
      shouldDefer: () => {
        const roll = useGameStore.getState().diceRoll;
        return !!roll && Date.now() - roll.startedAt < DICE_ROLL_DURATION_MS;
      },
      fetchGame: (id) => api<Game>(`/games/${id}/state`),
    });
    return () => { active = false; stop(); };
  }, [room?.gameId, connection, setGame, homeMode]);

  useEffect(() => { setSelected(null); }, [game?.question?.id, game?.turnNumber]);
  useEffect(() => { setBoardExpanded(false); }, [game?.id, game?.status, homeMode]);
  useEffect(() => {
    if (result && game && resultTurnNumber !== game.turnNumber) setResult(null);
  }, [game?.turnNumber, result, resultTurnNumber, setResult]);
  useEffect(() => {
    if (!game || game.status === "finished") return;
    setNow(serverNow());
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
    if (room || resumeRoom) { setError("Selesaikan atau lanjutkan ruang yang sudah ada sebelum memulai permainan baru."); return; }
    if (action === "join") { if (!user) { setIntent(action); setModal("login"); } else setModal("join"); return; }
    if (!user) { setIntent(action); setModal("login"); return; }
    if (action === "local") { setLocalNames(["", ""]); setError(""); setModal("local"); return; }
    await perform(async () => {
      const next = await api<Room>(action === "quick" ? "/rooms/quick" : "/rooms", { isPublic });
      acceptRoom(next); setGame(null); setResult(null);
    });
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      const me = user?.classroomHost
        ? await api<User>("/profile", { username: username.trim(), becomePlayer: true }, undefined, "PATCH")
        : await api<User>("/auth/guest", { username: username.trim() });
      setUser(me);
      if (!user && me.username !== username.trim()) {
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
      if (intent === "local") { setLocalNames(["", ""]); setModal("local"); return; }
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
      if (!user) setUser(await api<User>("/auth/guest", { username: "Kelas saya", classroomHost: true }));
      const next = await api<Room>("/rooms/local", { names: localNames.map((name) => name.trim()), includeHost: false });
      acceptRoom(next); setGame(null); setResult(null);
      setModal(null); setIntent(null);
    });
  }

  async function join(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      if (user?.classroomHost) {
        setIntent("join"); setUsername(""); setModal("login");
        return;
      }
      const next = await api<Room>(`/rooms/${encodeURIComponent(code.trim().toUpperCase())}/join`, {});
      acceptRoom(next); setModal(null); setResult(null);
    });
  }

  async function leaveRoom() {
    await perform(async () => {
      const leaving = room || resumeRoom;
      if (leaving) await api(`/rooms/${leaving.id}/leave`, {});
      resetGameplay(); setResumeRoom(null); sessionStorage.removeItem("adventure-room");
      setHomeMode(true); setModal(null);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/home`);
    });
  }

  function goHome() {
    if (room) setResumeRoom(room);
    resetGameplay(); setSelected(null); setHomeMode(true); setTab("adventure"); setError("");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/home`);
  }

  async function resume() {
    await perform(async () => {
      const activeRoom = await api<Room | null>("/rooms/current");
      if (!activeRoom) { setResumeRoom(null); setError("Ruang ini sudah tidak aktif. Kamu bisa mulai permainan baru."); return; }
      acceptRoom(activeRoom);
      if (activeRoom.gameId) setGame(await api<Game>(`/games/${activeRoom.gameId}/state`));
    });
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      const updated = await api<User>("/profile", { username: username.trim() }, undefined, "PATCH");
      setUser(updated); setModal(null); setNotice("Nama sesi diperbarui.");
    });
  }

  async function exitSession() {
    await perform(async () => {
      let remoteFailure = false;
      let memberRoom = room || resumeRoom;
      if (!memberRoom) { try { memberRoom = await api<Room | null>("/rooms/current"); } catch { remoteFailure = true; } }
      if (memberRoom) {
        try { await api(`/rooms/${memberRoom.id}/leave`, {}); } catch { remoteFailure = true; }
      }
      if (user?.teacherRole) {
        try { await api("/teacher/session/logout", {}); } catch { remoteFailure = true; }
        try { await signOutTeacher(); } catch { remoteFailure = true; }
      } else { try { await api("/auth/logout", {}); } catch { remoteFailure = true; } }
      clearSessionTokens();
      clearTeacherActorId();
      setUser(null); resetGameplay(); setResumeRoom(null); sessionStorage.removeItem("adventure-room");
      setSelected(null); setError(""); setNotice(""); setIntent(null); setRouteCode(""); setRouteGameId("");
      setHomeMode(true); setModal(null);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/home`);
      if (remoteFailure) setError("Sesi lokal sudah keluar, tetapi koneksi server gagal menyimpan sebagian perubahan.");
    });
  }

  function requestLeave() {
    if (game?.status === "playing" || (!room && resumeRoom?.status === "playing")) setModal("leave-room");
    else void leaveRoom();
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
  const myResult = result && resultTurnNumber === game?.turnNumber && (isLocal
    ? (room?.players || []).some((p) => p.id === result.playerId)
    : !result.playerId || result.playerId === user?.id) ? result : null;
  const feedbackPlayerName = game?.players.find((p) => p.id === myResult?.playerId)?.username || current?.username || "pemain";

  return <div ref={shellRef} className={`app-shell island-shell ${tab === "adventure" ? "is-adventure" : ""} ${tab === "adventure" && (homeMode || game?.status !== "playing") ? "has-front-panel" : ""} ${game?.status === "playing" && !homeMode ? "has-active-game" : ""} ${boardExpanded && game?.status === "playing" && !homeMode ? "board-expanded" : ""}`}>
    <aside className="sidebar">
      <a className="brand" href="#/home" onClick={(e) => { e.preventDefault(); goHome(); }} aria-label="Ular Tangga Adventure, beranda"><span className="brand-symbol"><Dice5 size={29} strokeWidth={2.4} /><Leaf className="brand-leaf" size={17} /></span><span>ular tangga<span className="brand-sub">ADVENTURE</span></span></a>
      <div className="nav-caption">RUANG KELAS</div>
      <nav aria-label="Navigasi utama">{navItems.map(({ id, name, icon: Icon }) => <button key={id} onClick={() => void openTab(id)} className={`nav-item ${tab === id ? "active" : ""}`} aria-current={tab === id ? "page" : undefined} aria-label={name}><Icon size={20} /><span>{name}</span>{tab === id && <span className="active-dot" />}</button>)}<button onClick={() => setModal("settings")} className="nav-item nav-icon-only" aria-label="Pengaturan"><Settings2 size={20} /><span>Pengaturan</span></button><button onClick={() => setModal("help")} className="nav-item nav-icon-only" aria-label="Panduan bermain"><CircleHelp size={20} /><span>Panduan bermain</span></button><a href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/guru/`} className="nav-item nav-icon-only" aria-label="Kelola bank soal"><ShieldCheck size={20} /><span>Panel guru</span></a></nav>
      <div className="field-note"><span className="note-icon"><BookOpen size={23} /></span><h3>Satu papan,<br />banyak pelajaran.</h3><p>Guru memandu kelas. Anak belajar sambil bermain.</p><button onClick={() => setModal("help")}>Lihat panduan <ArrowRight size={15} /></button><span className="note-leaf"><Leaf size={63} /></span></div>
      <div className="sidebar-bottom"><div className="sidebar-footer"><span className="status-dot" /> Belajar. Bermain. Bertualang.</div></div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><span>Ruang kelas</span><ChevronRight size={14} /><strong>{homeMode ? "Beranda" : navItems.find((n) => n.id === tab)?.name}</strong></div><div className="topbar-player"><a className="home-button" href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/guru/`} aria-label="Panel guru"><ShieldCheck size={16} /><span>Panel guru</span></a><button className="home-button" onClick={goHome} aria-label="Beranda"><Compass size={16} /><span>Beranda</span></button><button className="fullscreen-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Keluar layar penuh" : "Layar penuh"}><Maximize2 size={17} /><span>{fullscreen ? "Perkecil" : "Layar penuh"}</span></button>{user && <button className="session-control" onClick={() => { setUsername(user.username); setModal("identity"); }} aria-label={`Sesi ${user.username}; atur nama atau keluar sesi`}><BookOpen size={16} /><span>{user.classroomHost ? "Sesi perangkat" : user.username}</span><ChevronRight size={14} /></button>}</div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span /> MEDIA BELAJAR INTERAKTIF</div><h1>{tab === "adventure" ? "Papan belajar siap dimainkan" : navItems.find((n) => n.id === tab)?.name}</h1><p>{tab === "adventure" ? "Pilih nama pemain, lalu pandu giliran belajar bersama di papan." : "Siapkan permainan belajar untuk kelasmu."}</p></div><button className="guide-button" onClick={() => setModal("help")}><BookOpen size={17} /> Panduan guru <ArrowUpRight size={15} /></button></div>
        {error && <div className="alert error" role="alert"><CircleHelp size={18} /><span>{error}</span><button aria-label="Tutup pesan kesalahan" onClick={() => setError("")}><X size={16} /></button></div>}
        {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}

        {tab === "adventure" ? <>
          <div className="adventure-layout">
            <section className="map-card" aria-label="Papan petualangan Pulau Rimba">
              <div className="map-heading"><div><div className="map-eyebrow"><span className="map-number">01</span> PULAU PENGETAHUAN</div><h2>Ular Tangga<span className="title-star"> ✦</span></h2><p>Petak demi petak, menuju kemenangan.</p></div><span className="map-tag"><Leaf size={13} /> Hutan tropis</span></div>
              <div className="scene-container"><SceneBoundary><AdventureScene key={sceneKey} players={players.length ? players : previewPlayers} currentPlayerId={game?.currentPlayerId} totalSteps={game?.totalSteps || 100} snakes={game?.snakes ?? previewBoard.snakes} ladders={game?.ladders ?? previewBoard.ladders} diceRoll={diceRoll} diceValue={game?.diceResult ?? 0} quality={quality} reducedMotion={reducedMotion} focusPlayer={focusPlayer} /></SceneBoundary></div>
              {game?.status === "playing" && <button className="graphics-toggle" onClick={() => setQuality(quality === "high" ? "low" : "high")} aria-label={`Grafis ${quality === "high" ? "tinggi, lebih tajam" : "ringan, lebih hemat"}. Ketuk untuk mengubah`} title="Ubah tampilan papan"><Sparkles size={15} /><span>Grafis: {quality === "high" ? "Tinggi" : "Ringan"}</span></button>}
              <div className="board-toolbar"><div className="map-caption"><span className="live-dot" />{game ? `Giliran ${game.turnNumber} · ${current?.username || "Penjelajah"}${boardExpanded ? game.turnState === "QUESTION" ? ` · ${remaining} dtk` : game.turnState === "DICE_UNLOCKED" ? " · Dadu siap" : " · Bergerak…" : ""}` : "Jelajahi papan · 100 petak kejutan"}</div><p className="scene-help">Seret untuk melihat · Gulir / cubit untuk zoom</p><div className="scene-controls">{game?.status === "playing" && <button className="board-view-toggle" onClick={() => setBoardExpanded(!boardExpanded)} aria-label={boardExpanded ? "Kembali ke soal dan papan" : "Perbesar papan"}><span>{boardExpanded ? "Kembali ke soal" : "Papan penuh"}</span>{boardExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}<button className={`icon-button ${focusPlayer ? "selected" : ""}`} aria-label="Ikuti pemain aktif" aria-pressed={focusPlayer} onClick={() => setFocusPlayer(!focusPlayer)}><Maximize2 size={17} /></button><button className="icon-button" aria-label="Kembalikan sudut kamera" onClick={() => { setSceneKey(sceneKey + 1); setFocusPlayer(false); }}><RotateCcw size={17} /></button></div></div>
              <div className="map-footer"><span><Flag size={15} /><strong>{game?.totalSteps || 100}</strong> langkah petualangan</span><span><Users size={15} /><strong>2–4</strong> pemain</span><span><Mountain size={15} />Jalur penuh kejutan</span></div>
            </section>

            <aside className="play-panel">
              {homeMode ? <div className="resume-card"><div className="panel-kicker"><Smartphone size={17} /> BERANDA</div><h2>{resumeRoom ? "Petualanganmu siap dilanjutkan." : "Siap memulai petualangan?"}</h2><p className="panel-description">{resumeRoom ? "Waktu permainan tetap berjalan saat kamu di beranda." : "Tidak ada ruang aktif. Mulai permainan untuk kelasmu."}</p>{resumeRoom ? <><div className="room-code"><div><span>RUANG TERSIMPAN</span><h2>{resumeRoom.code}</h2></div></div><button className="button primary full" disabled={busy || !ready} onClick={() => void resume()}><ArrowRight size={18} />Lanjutkan permainan</button><button className="subtle-button" disabled={busy} onClick={requestLeave}><LogOut size={15} />Keluar permainan</button></> : <><button className="button primary full" onClick={() => { setHomeMode(false); setTab("adventure"); window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`); }}><ArrowRight size={18} />Mulai bermain</button></>}</div> : !room ? <>
                <button disabled={busy || !ready} className="button primary full local-primary" onClick={() => void startIntent("local")}><Smartphone size={20} /><span>Main di satu perangkat<small>2–4 pemain · satu layar</small></span><ArrowRight size={18} /></button>
                <div className="panel-kicker"><span className="tiny-spark"><Sparkles size={17} /></span> LEBIH SERU BERSAMA</div><h2>Ayo, mulai<br />petualanganmu.</h2><p className="panel-description">Ajak teman atau temukan penjelajah baru. Siapa yang tiba di puncak duluan?</p>
                <button disabled={busy || !ready} className="button secondary quick-button" onClick={() => void startIntent("quick")}><Zap size={19} fill="currentColor" />{busy ? "Menghubungkan..." : "Main cepat"}<ArrowRight size={19} /></button><span className="button-caption">Bergabung dengan ruang publik</span><div className="or-divider"><span>atau main dengan teman</span></div><button disabled={busy || !ready} className="button secondary full" onClick={() => void startIntent("create")}><Plus size={19} />Buat ruang</button><label className="check-label"><input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />Ruang terbuka untuk semua pemain</label><button disabled={busy || !ready} className="join-button" onClick={() => void startIntent("join")}>Punya kode ruang? <strong>Gabung <ArrowRight size={14} /></strong></button><div className="panel-rule"><ShieldCheck size={22} /><span>Jawaban salah? Tidak apa-apa.<br /><strong>Posisimu tetap, coba di giliran berikutnya.</strong></span></div>
              </> : !game ? <>{isLocal ? <><div className="panel-kicker"><Smartphone size={17} /> MODE SATU PERANGKAT</div><div className="room-code local"><div><span>SEMUA PEMAIN DI LAYAR INI</span><h2>Bergantian main</h2></div></div><p className="panel-description">Semua pemain menjawab pertanyaan dan melempar dadu bergantian di perangkat ini. Tidak perlu perangkat lain.</p><div className="room-players">{room.players.map((player, i) => <div className="room-player" key={player.id}><Avatar name={player.username} index={i} small /><strong>{player.username}</strong>{player.id === room.hostId ? <Crown size={16} /> : <span className="status-dot" />}</div>)}</div><button className="button primary full" disabled={busy || room.players.length < 2 || user?.id !== room.hostId} onClick={() => void perform(async () => { const next = await api<Game>(`/rooms/${room.id}/start`, {}); setGame(next); })}><Flag size={18} />Mulai petualangan</button><button className="subtle-button" disabled={busy} onClick={requestLeave}><LogOut size={15} />Keluar permainan</button></> : <><div className="panel-kicker"><Users size={17} /> RUANG PETUALANGAN</div><div className="room-code"><div><span>KODE RUANG</span><h2>{room.code}</h2></div><button className="icon-button" onClick={() => void copyInvite()} aria-label="Salin tautan undangan"><Copy size={20} /></button></div><p className="panel-description">Bagikan kode dan ajak temanmu masuk. Petualangan dimulai dengan 2–4 pemain.</p><div className="room-players">{room.players.map((player, i) => <div className="room-player" key={player.id}><Avatar name={player.username} index={i} small /><strong>{player.username}</strong>{player.id === room.hostId ? <Crown size={16} /> : <span className="status-dot" />}</div>)}{Array.from({ length: Math.max(0, 4 - room.players.length) }, (_, i) => <div className="empty-player" key={i}><Plus size={16} />Menunggu penjelajah...</div>)}</div><button className="button primary full" disabled={busy || room.players.length < 2 || user?.id !== room.hostId} onClick={() => void perform(async () => { const next = await api<Game>(`/rooms/${room.id}/start`, {}); setGame(next); })}><Flag size={18} />{user?.id === room.hostId ? "Mulai petualangan" : "Menunggu pemilik ruang"}</button><button className="subtle-button" disabled={busy} onClick={requestLeave}><LogOut size={15} />Keluar permainan</button></>}</> : game.status === "finished" ? <div className="victory"><span className="victory-icon"><Trophy size={44} /></span><div className="panel-kicker">PUNCAK TERCAPAI</div><h2>{game.players.find((p) => p.id === game.winnerId)?.username ? `${game.players.find((p) => p.id === game.winnerId)?.username} menang!` : "Permainan selesai"}</h2><p>Perjalanan selesai. Pengetahuan yang kamu temukan tetap bersamamu.</p><div className="results-list">{[...game.players].sort((a, b) => b.position - a.position).map((p, i) => <div key={p.id}><span>{i + 1}. {p.username}</span><strong>{p.position} / {game.totalSteps}</strong></div>)}</div><button disabled={busy} className="button primary full" onClick={requestLeave}>Kembali ke lobi <ArrowRight size={17} /></button></div> : <>
                <div className="turn-header"><span className="panel-kicker">GILIRAN {game.turnNumber}</span><span className={`connection ${connection}`} title={connection}>{connection === "connected" ? <Wifi size={15} /> : <WifiOff size={15} />}{connection === "connected" ? "Terhubung" : "Menyambungkan"}</span></div>
                <div className="turn-player"><Avatar name={current?.username || "?"} index={game.players.findIndex((p) => p.id === current?.id)} small /><div><h3>{isLocal ? `Giliran ${current?.username}` : isMyTurn ? "Sekarang giliranmu!" : `Giliran ${current?.username}`}</h3><span>Posisi {current?.position || 0} dari {game.totalSteps}</span></div></div>
                {isLocal && current && current.id !== user?.id && <div className="pass-hint" role="status"><Smartphone size={15} /><span>Giliran <strong>{current.username}</strong> · serahkan layar.</span></div>}
                {myResult && <div className={`answer-feedback ${myResult.result === "correct" ? "correct" : "incorrect"}`} role="status"><strong>{myResult.result === "correct" ? (isLocal ? `Jawaban ${feedbackPlayerName} benar! Dadunya terbuka.` : "Jawaban benar! Dadumu terbuka.") : myResult.result === "timeout" ? "Waktu habis. Posisi tetap." : isLocal ? `Jawaban ${feedbackPlayerName} belum tepat. Posisi tetap ${myResult.position}.` : `Belum tepat. Posisi tetap ${myResult.position}.`}</strong>{myResult.explanation && <p>{myResult.explanation}</p>}</div>}
                {game.turnState === "QUESTION" && game.question ? <><div className="question-meta"><span>{game.question.category || "Pengetahuan umum"}</span><span className={remaining <= 10 ? "timer urgent" : "timer"}><Timer size={15} />{remaining} dtk</span></div><h3 className="question-text">{game.question.question}</h3><div className="answer-options">{game.question.options.map((option, index) => <button disabled={!canAct || busy || remaining <= 0} key={index} className={`answer-option ${selected === index ? "chosen" : ""}`} onClick={() => setSelected(index)} aria-pressed={selected === index}><span>{String.fromCharCode(65 + index)}</span>{option}{selected === index && <Check size={16} />}</button>)}</div><button disabled={!canAct || selected === null || busy || remaining <= 0} className="button primary full" onClick={() => void perform(async () => { const gameId = game.id; const answerResult = await api<AnswerResult>(`/games/${gameId}/question/answer`, { questionId: game.question!.id, answer: selected, ...(isLocal ? { playerId: game.currentPlayerId } : {}) }); setResult({ ...answerResult, playerId: isLocal ? game.currentPlayerId : user!.id }, game.turnNumber); const state = useGameStore.getState(); if (state.connection !== "connected" && state.game?.id === gameId) { const fresh = await api<Game>(`/games/${gameId}/state`); if (useGameStore.getState().game?.id === gameId) setGame(fresh); } })}>{busy ? "Memeriksa jawaban..." : canAct ? "Kunci jawaban" : "Menunggu jawaban..."}<LockKeyhole size={15} /></button></> : game.turnState === "DICE_UNLOCKED" ? <div className="dice-panel"><Dice5 size={66} strokeWidth={1.5} /><h3>Pengetahuan membuka jalan.</h3><p>{canAct ? (isLocal && current && current.id !== user?.id ? `Dadu ${current.username} sudah terbuka. Lempar sekarang!` : "Dadumu sudah terbuka. Tentukan langkah berikutnya!") : "Menunggu pemain melempar dadu."}</p><button disabled={!canAct || busy} className="button primary full" onClick={() => void rollDice()}><Dice5 size={19} />{busy ? "Melempar..." : "Lempar dadu"}</button></div> : <div className="dice-panel"><Dice5 size={64} /><h2>{diceRoll && now - diceRoll.startedAt < DICE_ROLL_DURATION_MS ? "…" : game.diceResult || "…"}</h2><p>{diceRoll && now - diceRoll.startedAt < DICE_RELEASE_MS ? "Kocok dulu… berapa langkah kali ini?" : diceRoll && now - diceRoll.startedAt < DICE_ROLL_DURATION_MS ? "Tunggu sampai dadunya berhenti…" : "Menjelajahi jalur berikutnya..."}</p></div>}
                {isLocal ? <><span className="subtle-button static"><Smartphone size={14} />Mode satu perangkat · {room.code}</span><button className="subtle-button" disabled={busy} onClick={requestLeave}><LogOut size={15} />Keluar permainan</button></> : <><button className="subtle-button" disabled={busy} onClick={() => void copyInvite()}><Copy size={14} />Ruang {room.code}</button><button className="subtle-button" disabled={busy} onClick={requestLeave}><LogOut size={15} />Keluar permainan</button></>}
              </>}
              {game?.status === "playing" && <details className="mobile-roster"><summary>Posisi & peringkat pemain</summary><div className="mobile-roster-body"><div className="room-players">{game.players.map((player, i) => <div className="room-player" key={player.id}><Avatar name={player.username} index={i} small /><strong>{player.username}</strong><span>Langkah {player.position}/{game.totalSteps}</span></div>)}</div><Leaderboard entries={rankRoster(game.players, leaderboard)} sharedFirst={rankRoster(game.players, leaderboard).filter((entry) => entry.rank === 1 && entry.correctAnswers > 0).length > 1} compact /></div></details>}
            </aside>
          </div>

          {game && <section className="players-strip" aria-label="Posisi pemain">{game.players.map((p, i) => <div key={p.id} className={`player-progress ${p.id === game.currentPlayerId ? "current" : ""}`}><Avatar name={p.username} index={i} small /><div><strong>{p.username}{!isLocal && p.id === user?.id ? " (kamu)" : ""}</strong><span>Langkah {p.position} / {game.totalSteps}</span><progress value={p.position} max={game.totalSteps} aria-label={`Kemajuan ${p.username}`} /></div>{p.id === game.currentPlayerId && <Flag size={15} />}</div>)}</section>}
        {game && <section className="class-scoreboard"><div className="section-label"><span className="eyebrow">SKOR KUMULATIF · PEMAIN RUANG INI</span><h2>Peringkat pemain</h2></div><Leaderboard entries={rankRoster(game.players, leaderboard)} sharedFirst={rankRoster(game.players, leaderboard).filter((entry) => entry.rank === 1 && entry.correctAnswers > 0).length > 1} compact /></section>}

          <section className="journey-guide"><div className="section-label"><span className="eyebrow">SATU JAWABAN, BANYAK KEMUNGKINAN</span><h2>Begini petualanganmu berjalan</h2></div><div className="journey-steps"><div className="journey-step"><span className="step-icon green"><BookOpen size={22} /></span><div><h3>Jawab tantangan</h3><p>Uji pengetahuanmu di setiap giliran.</p></div></div><ChevronRight className="step-arrow" size={18} /><div className="journey-step"><span className="step-icon yellow"><Dice5 size={23} /></span><div><h3>Buka & lempar dadu</h3><p>Jawaban benar membuka langkahmu.</p></div></div><ChevronRight className="step-arrow" size={18} /><div className="journey-step"><span className="step-icon peach"><Flag size={22} /></span><div><h3>Temukan kejutan</h3><p>Seberangi jembatan. Waspadai ular!</p></div></div></div></section>
          <div className="bottom-row"><div className="expedition-note"><span className="expedition-icon"><Leaf size={23} /></span><div><h3>Bukan sekadar sampai di puncak.</h3><p>Ini tentang hal-hal baru yang kamu pelajari di perjalanan.</p></div><span className="handdrawn-arrow"><ArrowUpRight size={35} /></span></div><button className="public-rooms-toggle" disabled={busy} onClick={() => void perform(async () => { const rooms = await api<Room[]>("/rooms"); setPublicRooms(rooms || []); setDirectoryLoaded(true); })}><Users size={18} /><span>Temukan teman bermain<strong>Lihat ruang publik <ArrowRight size={15} /></strong></span></button></div>
          {directoryLoaded && <section className="directory"><h2>Ruang publik</h2>{publicRooms.length ? publicRooms.map((r) => <div key={r.id}><strong>{r.code}</strong><span>{r.players.length}/4 pemain</span><button disabled={busy || !!room} className="button small-button secondary" onClick={() => { setCode(r.code); void startIntent("join"); }}>Gabung <ArrowRight size={15} /></button></div>) : <p>Belum ada ruang publik. Buat ruang terbuka untuk mengajak penjelajah lain.</p>}</section>}
        </> : <section className="account-page">
          {!user ? <div className="empty-state"><Trophy size={42} /><h2>Masuk untuk melihat peringkat.</h2><p>Nama dan jawaban benar siswa tampil bersama seluruh permainan kelas.</p><button className="button primary" onClick={() => { setIntent(null); setModal("login"); }}>Mulai sesi kelas <ArrowRight size={17} /></button></div> : <>
            <div className="leaderboard-head"><div><h2>Jawaban benar terbanyak</h2><p>Semua pemain · jawaban benar terakumulasi antar permainan. Di mode satu perangkat, gunakan sesi perangkat dan nama anak yang sama agar progres berlanjut; nama saja bukan cara memulihkan sesi.</p></div><span className="map-tag">Semua permainan</span></div>
            <Leaderboard entries={leaderboard} />
          </>}
        </section>}
        <footer className="page-footer"><span>ULAR TANGGA <strong>ADVENTURE</strong></span><span>Dibuat untuk rasa ingin tahu.<Leaf size={13} /></span></footer>
      </main>
    </div>

    {modal === "login" && <Modal title="Nama pemain" onClose={() => setModal(null)}><p>Nama ini tampil di ruang dan peringkat. Tidak perlu email.</p><form onSubmit={(e) => void login(e)}><label className="field-label" htmlFor="username">Nama pemain</label><input id="username" autoFocus minLength={2} maxLength={24} required placeholder="Contoh: Nara" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="nickname" />{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || username.trim().length < 2}>{busy ? "Menyiapkan sesi..." : "Lanjutkan"}<ArrowRight size={18} /></button><p className="privacy-note"><ShieldCheck size={15} />Nama bukan cara memulihkan sesi lama. Skor yang sudah tersimpan tetap ada.</p></form></Modal>}
    {modal === "identity" && user && <Modal title={user.classroomHost ? "Sesi perangkat" : "Sesi pemain"} onClose={() => setModal(null)}><p>Nama: <strong>{user.username}</strong></p><form onSubmit={(e) => void saveName(e)}><label className="field-label" htmlFor="profile-name">Ubah nama tampilan</label><input id="profile-name" autoFocus minLength={2} maxLength={24} required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="nickname" />{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || username.trim().length < 2}>{busy ? "Menyimpan..." : "Simpan nama"}<Check size={17} /></button></form><p className="privacy-note">Nama hanya label tampilan. Sesi ini tersimpan di browser yang sama.</p><button className="subtle-button session-exit" onClick={() => setModal("exit-session")}><LogOut size={15} />Keluar dari sesi</button></Modal>}
    {modal === "exit-session" && <Modal title="Keluar dari sesi?" onClose={() => setModal("identity")} restoreFocus={false}><p>Skor tetap tersimpan. Sesi baru tidak menghubungkan peringkat lama hanya dari nama. {sessionRoom?.status === "playing" ? ownerEndsRoom ? "Sebagai pengendali mode satu perangkat, keluar juga akan mengakhiri permainan untuk semua anak." : "Kamu akan keluar dari room; pemain lain dapat melanjutkan. Waktu tetap berjalan." : "Untuk bermain lagi dengan peringkat yang sama, gunakan Beranda atau Keluar permainan."}</p><div className="modal-actions"><button className="button secondary" onClick={() => setModal("identity")}>Tetap di sini</button><button className="button primary" disabled={busy} onClick={() => void exitSession()}>{busy ? "Keluar..." : "Keluar dari sesi"}</button></div></Modal>}
    {modal === "leave-room" && <Modal title="Keluar dari permainan?" onClose={() => setModal(null)}><p>{sessionRoom?.status === "playing" ? ownerEndsRoom ? "Kamu mengendalikan permainan satu perangkat ini. Keluar akan mengakhiri permainan untuk semua anak." : "Kamu akan meninggalkan room. Pemain lain dapat melanjutkan, dan permainan bisa berakhir jika jumlah pemain tidak cukup." : "Keluar dari permainan akan melepas room ini, tetapi skor yang sudah dicatat tetap tersimpan."} Waktu permainan terus berjalan jika kamu memilih Beranda.</p><div className="modal-actions"><button className="button secondary" onClick={() => setModal(null)}>Tetap bermain</button><button className="button primary" disabled={busy} onClick={() => void leaveRoom()}>{busy ? "Keluar..." : "Keluar permainan"}</button></div></Modal>}
    {modal === "join" && <Modal title="Temanmu sudah menunggu." onClose={() => setModal(null)}><p>Masukkan kode ruang yang dibagikan temanmu.</p><form onSubmit={(e) => void join(e)}><label className="field-label" htmlFor="room-code">Kode ruang</label><input id="room-code" className="code-input" autoFocus required maxLength={8} minLength={5} placeholder="A7K29" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || code.length < 5}>{busy ? "Bergabung..." : "Gabung petualangan"}<ArrowRight size={18} /></button></form></Modal>}
    {modal === "local" && <Modal title="Main di satu perangkat" onClose={() => setModal(null)}><p>Masukkan nama 2–4 anak yang akan bergantian menjawab dan melempar dadu di layar ini.</p><form onSubmit={(e) => void createLocal(e)}>{localNames.map((name, i) => <div className="local-player-row" key={i}><div><label className="field-label" htmlFor={`local-name-${i}`}>Nama pemain {i + 1}</label><input id={`local-name-${i}`} autoFocus={i === 0} required minLength={2} maxLength={24} placeholder={["Contoh: Nara", "Contoh: Bima", "Contoh: Lila", "Nama pemain"][i]} value={name} onChange={(e) => setLocalNames(localNames.map((value, j) => j === i ? e.target.value : value))} autoComplete="off" /></div>{localNames.length > 2 && <button type="button" className="icon-button" aria-label={`Hapus ${name || `pemain ${i + 1}`}`} onClick={() => setLocalNames(localNames.filter((_, j) => j !== i))}><X size={16} /></button>}</div>)}{localNames.length < 4 && <button type="button" className="button secondary full add-player" disabled={busy} onClick={() => setLocalNames([...localNames, ""])}><Plus size={16} />Tambah pemain ({localNames.length + 1} dari 4)</button>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || !localNamesReady}>{busy ? "Menyiapkan ruang..." : `Mulai dengan ${localNames.length} pemain`}<ArrowRight size={18} /></button><p className="privacy-note"><Smartphone size={15} />Gunakan nama yang sama agar peringkat berlanjut.</p></form></Modal>}
    {modal === "help" && <Modal title="Panduan guru" onClose={() => setModal(null)}><div className="help-list"><div><BookOpen /><section><h3>Satu giliran, satu pertanyaan</h3><p>Berikan waktu 30 detik untuk memilih jawaban. Pertanyaan dijawab bergantian.</p></section></div><div><Dice5 /><section><h3>Jawaban benar membuka dadu</h3><p>Lempar dadu untuk menggerakkan pemain dan menghubungkan soal dengan perjalanan di papan.</p></section></div><div><ShieldCheck /><section><h3>Jawaban salah tetap aman</h3><p>Posisi pemain tetap dan giliran beralih. Gunakan penjelasan soal untuk membahas jawabannya bersama kelas.</p></section></div><div><Smartphone /><section><h3>Main di satu perangkat</h3><p>Pilih "Main di satu perangkat", isi nama 2–4 anak, lalu serahkan layar bergantian. Tidak perlu perangkat lain.</p></section></div><div><ArrowUpRight /><section><h3>Jembatan dan ular menguatkan konsep</h3><p>Jembatan membawa pemain maju, ular membawa pemain mundur. Capai posisi 100 untuk menyelesaikan permainan.</p></section></div></div><button className="button primary full" onClick={() => setModal(null)}>Siap mengajar <ArrowRight size={17} /></button></Modal>}
    {modal === "settings" && <Modal title="Atur petualanganmu" onClose={() => setModal(null)}><label className="field-label" htmlFor="quality">Kualitas tampilan</label><select id="quality" value={quality} onChange={(e) => setQuality(e.target.value as "low" | "high")}><option value="high">Tinggi · lebih tajam</option><option value="low">Ringan · lebih hemat</option></select><p className="quality-note">Tampilan lebih tajam bisa terasa lebih berat pada sebagian perangkat.</p><label className="setting-check"><input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} /><span><strong>Kurangi animasi</strong><small>Gerakan lebih sederhana, aturan tetap sama.</small></span></label><p className="privacy-note">Audio belum diaktifkan pada versi ini.</p><button className="button primary full" onClick={() => setModal(null)}>Terapkan pengaturan <Check size={17} /></button></Modal>}
  </div>;
}

function Leaderboard({ entries, compact = false, sharedFirst: sharedFirstOverride }: { entries: LeaderboardEntry[]; compact?: boolean; sharedFirst?: boolean }) {
  if (!entries.length) return <div className="empty-state"><Trophy size={40} /><h3>Belum ada penjelajah di papan peringkat.</h3><p>Mulai permainan kelas untuk mencatat jawaban benar pertama.</p></div>;
  const sharedFirst = sharedFirstOverride ?? entries.filter((entry) => entry.rank === 1 && entry.correctAnswers > 0).length > 1;
  return <div className={`leaderboard-list${compact ? " compact" : ""}`} aria-label="Peringkat jawaban benar seluruh permainan">{entries.map((entry, i) => {
    const champion = entry.rank === 1 && entry.correctAnswers > 0;
    return <div key={entry.id} className={champion ? "leaderboard-champion" : ""}><span className="rank">{entry.rank}</span><Avatar name={entry.username} index={i} small /><strong>{entry.username}</strong>{champion && <span className="leaderboard-badge"><Crown size={14} />{sharedFirst ? "Juara bersama" : "Juara"}</span>}<b>{entry.correctAnswers} jawaban benar</b></div>;
  })}{!compact && <p className="muted">Semua penjelajah ditampilkan, termasuk yang belum mendapat jawaban benar.</p>}</div>;
}
