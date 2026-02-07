import { useState, useEffect, useCallback, useRef } from "react";

const ZONES = [
  "San Isidro", "Vicente López", "San Fernando", "Tigre",
  "San Martín", "Tres de Febrero", "Pilar", "Escobar",
  "Belgrano", "Núñez", "Saavedra", "Coghlan"
];

const POPULAR_LINES = [
  "15","19","21","28","29","33","34","37","39","41","42","44","55","57",
  "59","60","63","64","65","67","68","71","78","80","87","93","107","113",
  "114","118","127","130","134","140","142","148","152","159","160","161",
  "166","168","169","175","176","184","194","203","219","228","263","300",
  "333","365","371","372","407","430","437","502","584","603","619","700",
  "707","710","720","721","723","740","842"
];

const STATUS_MAP = {
  paro_total: { label: "PARO TOTAL", color: "#DC2626", icon: "🚫", priority: 4 },
  paro_parcial: { label: "PARO PARCIAL", color: "#D97706", icon: "⚠️", priority: 3 },
  demoras: { label: "DEMORAS", color: "#2563EB", icon: "🕐", priority: 2 },
  levantado: { label: "LEVANTADO", color: "#8B5CF6", icon: "🟢", priority: 1 },
  normal: { label: "NORMAL", color: "#16A34A", icon: "✅", priority: 0 },
};

const REFRESH_OPTIONS = [
  { label: "5 min", value: 5 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "1 hora", value: 60 },
  { label: "Off", value: 0 },
];

const PRIORITY_SOURCES = [
  { name: "TN", domain: "tn.com.ar", icon: "📺", principal: true },
  { name: "Ciudad de Bondis", domain: "x.com/CiudadDeBondis", icon: "𝕏", principal: true },
  { name: "Paro de Bondis", domain: "parodebondis.com.ar", icon: "🚌", principal: false },
  { name: "La Nación", domain: "lanacion.com.ar", icon: "📰", principal: false },
  { name: "Infobae", domain: "infobae.com", icon: "📰", principal: false },
  { name: "Canal 26", domain: "canal26.com", icon: "📺", principal: false },
  { name: "C5N", domain: "c5n.com", icon: "📺", principal: false },
  { name: "Infocielo", domain: "infocielo.com", icon: "📰", principal: false },
  { name: "Alertas Tránsito", domain: "alertastransito.com", icon: "🚦", principal: false },
  { name: "Página/12", domain: "pagina12.com.ar", icon: "📰", principal: false },
];

// ── Robust JSON extractor ──
function extractJSON(text) {
  if (!text || typeof text !== "string") return null;
  // Strip markdown fences
  let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/gi, "");
  // Try direct parse first
  try { return JSON.parse(clean.trim()); } catch {}
  // Find balanced braces
  let depth = 0, start = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (clean[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        let candidate = clean.substring(start, i + 1);
        // Fix trailing commas
        candidate = candidate.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
        try { return JSON.parse(candidate); } catch {}
      }
    }
  }
  return null;
}

// ── Extract text from API response (handles web_search tool blocks) ──
function extractTextFromResponse(data) {
  if (!data || !data.content) return "";
  return data.content
    .filter(block => block.type === "text" && block.text)
    .map(block => block.text)
    .join("\n");
}

// ── Determine API endpoint ──
function getApiUrl() {
  if (typeof window === "undefined") return "/api/chat";
  const host = window.location.hostname;
  // Claude.ai artifacts / sandbox / preview → direct API (no key needed)
  if (host.includes("claude.ai") || host.includes("anthropic") || host.includes("cloudfront") || host === "localhost" || host === "127.0.0.1" || host === "") {
    return "https://api.anthropic.com/v1/messages";
  }
  // Vercel or custom domain → use serverless proxy
  return "/api/chat";
}

export default function HoyNoHayBondi() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [rawSummary, setRawSummary] = useState("");
  const [activeTab, setActiveTab] = useState("resumen");
  const [debugInfo, setDebugInfo] = useState("");

  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notifPermission, setNotifPermission] = useState("default");
  const [autoRefreshMin, setAutoRefreshMin] = useState(15);
  const [notifHistory, setNotifHistory] = useState([]);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [favoriteLines, setFavoriteLines] = useState([]);
  const [notifyOnlyFavorites, setNotifyOnlyFavorites] = useState(false);
  const autoRefreshRef = useRef(null);
  const prevStatusRef = useRef(new Map());

  const [filterText, setFilterText] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [provider, setProvider] = useState(null); // 'anthropic' | 'openai'

  const requestNotifPermission = useCallback(async () => {
    if (!("Notification" in window)) { addNotifHistory("⚠️ Navegador no soporta notificaciones"); return; }
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === "granted") {
      setNotificationsEnabled(true);
      addNotifHistory("✅ Notificaciones activadas");
      try { new Notification("Hoy No Hay Bondi", { body: "Notificaciones activadas" }); } catch {}
    } else { addNotifHistory("❌ Permiso denegado"); }
  }, []);

  const sendNotif = useCallback((title, body) => {
    if (notifPermission === "granted" && notificationsEnabled) {
      try { new Notification(title, { body }); } catch {}
    }
  }, [notifPermission, notificationsEnabled]);

  const addNotifHistory = useCallback((msg) => {
    setNotifHistory(prev => [
      { text: msg, time: new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) },
      ...prev.slice(0, 24)
    ]);
  }, []);

  const toggleFavorite = useCallback((line) => {
    setFavoriteLines(prev => prev.includes(line) ? prev.filter(l => l !== line) : [...prev, line]);
  }, []);

  const buildPrompt = () => {
    const today = new Date();
    const dateStr = today.toLocaleDateString("es-AR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    return `Hoy es ${dateStr}. Necesito información ACTUALIZADA AL DÍA DE HOY sobre paros, demoras, interrupciones y LEVANTAMIENTOS de paros de colectivos en el AMBA, con foco en zona norte del conurbano y CABA zona norte.

FUENTES A CONSULTAR:
1. tn.com.ar (buscar "paro colectivos hoy")
2. @CiudadDeBondis en X/Twitter (88.8k seguidores, referente info colectivos)
3. parodebondis.com.ar
4. lanacion.com.ar / infobae.com / canal26.com / c5n.com / infocielo.com

ZONAS: San Isidro, Vicente López, San Fernando, Tigre, San Martín, Tres de Febrero, Pilar, Escobar, y CABA zona norte (Belgrano, Núñez, Saavedra, Coghlan).

LÍNEAS: 15, 19, 21, 28, 29, 33, 34, 37, 39, 41, 42, 44, 55, 57, 59, 60, 63, 64, 65, 67, 68, 71, 78, 80, 87, 93, 107, 113, 114, 118, 127, 130, 134, 140, 142, 148, 152, 159, 160, 161, 166, 168, 169, 175, 176, 184, 194, 203, 219, 228, 263, 300, 333, 365, 371, 372, 407, 430, 437, 502, 584, 603, 619, 700, 707, 710, 720, 721, 723, 740, 842.

EMPRESAS: MOGSM, MOQSA, El Nuevo Halcón, DOTA, y cualquier otra.

IMPORTANTE: Si un paro fue LEVANTADO hoy, reportalo con estado "levantado" e indicá la hora.

RESPONDÉ SOLO CON JSON PURO. Sin backticks, sin markdown, sin texto extra. Empezá directo con la llave {

{"fecha":"${dateStr}","hay_paros":true,"resumen_general":"texto","lineas_afectadas":[{"linea":"número","empresa":"nombre","estado":"paro_total|paro_parcial|demoras|levantado|normal","motivo":"razón","desde":"hora","hasta":"hora o sin definir","zonas":["zona"],"fuente":"medio"}],"paros_levantados":[{"linea":"número","empresa":"nombre","hora_levantamiento":"hora","detalle":"qué pasó","servicio_normalizado":true,"fuente":"medio"}],"proximas_medidas":[{"fecha":"fecha","tipo":"paro|movilización","convocante":"quién","detalle":"qué","fuente":"medio"}],"info_general":[{"titulo":"título","detalle":"detalle","fuente":"medio","url":"url"}],"fuentes_consultadas":["fuente1"],"confiabilidad":"alta|media|baja","nota":"aclaración"}`;
  };

  const checkBusStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    setDebugInfo("");
    if (!silent) setRawSummary("");
    setProvider(null);
    setRetryAttempt(0);

    const MAX_RETRIES = 2;
    const TIMEOUT_MS = 50000; // 50 seconds timeout per attempt
    const RETRYABLE_STATUSES = [429, 500, 502, 503, 529];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        setRetryAttempt(attempt);
        const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 8000);
        await new Promise(r => setTimeout(r, backoffMs));
      }

      const apiUrl = getApiUrl();
      const isDirect = apiUrl.startsWith("https://");
      const requestBody = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: buildPrompt() }]
      };

      const headers = { "Content-Type": "application/json" };
      if (isDirect) {
        headers["anthropic-version"] = "2023-06-01";
      }

      let data;

      // Primary request with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response;
      try {
        response = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const status = response.status;
        // If credit/rate limit error on direct API, try proxy (which has OpenAI fallback)
        if (isDirect && (status === 429 || status === 529)) {
          const fallbackController = new AbortController();
          const fallbackTimeout = setTimeout(() => fallbackController.abort(), TIMEOUT_MS);
          let fallbackResponse;
          try {
            fallbackResponse = await fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
              signal: fallbackController.signal
            });
          } finally {
            clearTimeout(fallbackTimeout);
          }
          if (!fallbackResponse.ok) {
            const errData = await fallbackResponse.text().catch(() => "");
            throw new Error(`API ${status} (Anthropic) → Fallback ${fallbackResponse.status}: ${errData.substring(0, 300)}`);
          }
          data = await fallbackResponse.json();
        } else if (RETRYABLE_STATUSES.includes(status) && attempt < MAX_RETRIES) {
          continue; // Retry on transient errors
        } else {
          const errData = await response.text().catch(() => "");
          throw new Error(`API ${response.status}: ${errData.substring(0, 300)}`);
        }
      } else {
        data = await response.json();
      }

      // Track which provider answered
      if (data._provider) setProvider(data._provider);

      // Extract text from response (handles mixed content with web_search blocks)
      const fullText = extractTextFromResponse(data);
      const blockTypes = (data.content || []).map(b => b.type).join(",");
      setDebugInfo(`URL: ${apiUrl} | Bloques: ${blockTypes} | Texto: ${fullText.length}c | Stop: ${data.stop_reason || "?"}`);

      // Strategy 1: Parse from text blocks
      let parsed = fullText ? extractJSON(fullText) : null;

      // Strategy 2: Try each text block individually
      if (!parsed && data.content) {
        for (const block of data.content) {
          if (block.type === "text" && block.text) {
            parsed = extractJSON(block.text);
            if (parsed && (parsed.lineas_afectadas || parsed.fecha)) break;
          }
        }
      }

      // Strategy 3: Look for JSON in the full stringified response
      if (!parsed) {
        const fullStr = JSON.stringify(data);
        const jsonMatch = fullStr.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
        if (jsonMatch) {
          for (const m of jsonMatch) {
            try {
              const inner = JSON.parse(m.replace(/^"text"\s*:\s*/, ""));
              const attempt = extractJSON(inner);
              if (attempt && (attempt.lineas_afectadas || attempt.fecha)) { parsed = attempt; break; }
            } catch {}
          }
        }
      }

      if (parsed && (parsed.lineas_afectadas || parsed.fecha)) {
        setResults(parsed);
        setRawSummary(parsed.resumen_general || "");
        setLastUpdate(new Date());

        // ── Notifications logic ──
        if (notificationsEnabled && parsed.lineas_afectadas) {
          const currentMap = new Map();
          parsed.lineas_afectadas.forEach(l => currentMap.set(String(l.linea), l.estado));
          const prevMap = prevStatusRef.current;

          const newStrikes = parsed.lineas_afectadas.filter(l => {
            const prev = prevMap.get(String(l.linea));
            return (l.estado === "paro_total" || l.estado === "paro_parcial") && prev !== l.estado;
          });
          if (newStrikes.length > 0) {
            const relevant = notifyOnlyFavorites && favoriteLines.length > 0
              ? newStrikes.filter(l => favoriteLines.includes(String(l.linea))) : newStrikes;
            if (relevant.length > 0) {
              sendNotif(`🚨 ${relevant.length} línea${relevant.length > 1 ? "s" : ""} en paro`,
                relevant.map(l => `${l.linea}: ${STATUS_MAP[l.estado]?.label}`).join(", "));
              relevant.forEach(l => addNotifHistory(`🚨 Línea ${l.linea}: ${STATUS_MAP[l.estado]?.label} — ${l.motivo || ""}`));
            }
          }

          const liftedLines = parsed.lineas_afectadas.filter(l => l.estado === "levantado");
          const newLifted = liftedLines.filter(l => prevMap.get(String(l.linea)) !== "levantado");
          if (newLifted.length > 0) {
            const relevant = notifyOnlyFavorites && favoriteLines.length > 0
              ? newLifted.filter(l => favoriteLines.includes(String(l.linea))) : newLifted;
            if (relevant.length > 0) {
              sendNotif(`🟢 Paro levantado: ${relevant.map(l => l.linea).join(", ")}`, "Servicio restableciéndose");
              relevant.forEach(l => addNotifHistory(`🟢 Línea ${l.linea}: LEVANTADO — ${l.motivo || ""}`));
            }
          }

          for (const [line, oldStatus] of prevMap) {
            if ((oldStatus === "paro_total" || oldStatus === "paro_parcial") && !currentMap.has(line)) {
              const shouldNotify = !notifyOnlyFavorites || favoriteLines.length === 0 || favoriteLines.includes(line);
              if (shouldNotify) {
                sendNotif(`✅ Línea ${line}: normalizado`, "Paro levantado");
                addNotifHistory(`✅ Línea ${line}: normalizado`);
              }
            }
          }
          prevStatusRef.current = currentMap;
        }
        if (!silent) addNotifHistory("🔄 OK — " + (parsed.fuentes_consultadas?.length || 0) + " fuentes");
      } else if (parsed) {
        // Got JSON but without lineas_afectadas
        setResults(parsed);
        setRawSummary(parsed.resumen_general || JSON.stringify(parsed, null, 2));
        setLastUpdate(new Date());
      } else {
        // Couldn't parse JSON at all
        const fallbackText = fullText || (data.content || []).map(b => JSON.stringify(b).substring(0, 500)).join("\n---\n");
        setRawSummary(fallbackText || "Respuesta vacía de la API");
        setResults(null);
        setLastUpdate(new Date());
      }
    } catch (err) {
      const isTimeout = err.name === "AbortError";
      const isRetryable = isTimeout || /^API (429|500|502|503|529)/.test(err.message);
      if (isRetryable && attempt < MAX_RETRIES) continue; // Retry on timeout or transient error
      const msg = isTimeout ? "La consulta tardó demasiado. Intentá de nuevo." : err.message;
      setError(msg);
      addNotifHistory("❌ " + msg);
    } finally {
      setLoading(false);
    }
    break; // Exit retry loop on success
    } // end retry for-loop
  }, [notificationsEnabled, notifyOnlyFavorites, favoriteLines, sendNotif, addNotifHistory]);

  useEffect(() => { checkBusStatus(); }, []);

  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (autoRefreshMin > 0 && notificationsEnabled) {
      autoRefreshRef.current = setInterval(() => checkBusStatus(true), autoRefreshMin * 60 * 1000);
      return () => clearInterval(autoRefreshRef.current);
    }
  }, [autoRefreshMin, notificationsEnabled, checkBusStatus]);

  const filteredLines = (results?.lineas_afectadas || []).filter(l => {
    const matchText = !filterText || String(l.linea).toLowerCase().includes(filterText.toLowerCase());
    const matchStatus = filterStatus === "all" || l.estado === filterStatus;
    return matchText && matchStatus;
  }).sort((a, b) => (STATUS_MAP[b.estado]?.priority || 0) - (STATUS_MAP[a.estado]?.priority || 0));

  const fmt = (d) => d ? d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "--:--";
  const affectedCount = results?.lineas_afectadas?.filter(l => l.estado !== "normal" && l.estado !== "levantado").length || 0;
  const liftedCount = (results?.lineas_afectadas?.filter(l => l.estado === "levantado").length || 0) + (results?.paros_levantados?.length || 0);

  const [countdown, setCountdown] = useState("");
  useEffect(() => {
    if (!notificationsEnabled || autoRefreshMin === 0 || !lastUpdate) { setCountdown(""); return; }
    const iv = setInterval(() => {
      const diff = Math.max(0, Math.floor((lastUpdate.getTime() + autoRefreshMin * 60000 - Date.now()) / 1000));
      setCountdown(`${Math.floor(diff / 60)}:${String(diff % 60).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(iv);
  }, [lastUpdate, autoRefreshMin, notificationsEnabled]);

  const tabDefs = [
    { id: "resumen", label: `📋 Líneas${affectedCount ? ` (${affectedCount})` : ""}` },
    { id: "levantados", label: `🟢 Levantados${liftedCount ? ` (${liftedCount})` : ""}` },
    { id: "noticias", label: `📰 Noticias${results?.info_general?.length ? ` (${results.info_general.length})` : ""}` },
  ];
  if (results?.proximas_medidas?.length) tabDefs.push({ id: "proximas", label: `📅 Próximas (${results.proximas_medidas.length})` });

  // ── Shared styles ──
  const S = {
    panel: { background: "#111", border: "1px solid #262626", borderRadius: 12, padding: 20, marginBottom: 20, animation: "slideDown 0.2s ease-out" },
    row: { display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0A0A0A", borderRadius: 8, padding: "12px 16px", marginBottom: 12 },
    btnSmall: (active, color) => ({
      padding: "5px 10px", fontSize: 11, fontWeight: 700,
      background: active ? (color || "#FBBF24") : "#1A1A1A",
      color: active ? "#0A0A0A" : "#666",
      border: `1px solid ${active ? (color || "#FBBF24") : "#262626"}`,
      borderRadius: 5, cursor: "pointer", fontFamily: "'Courier New', monospace"
    }),
    toggle: (on) => ({
      width: 52, height: 28, borderRadius: 14, border: "none", cursor: "pointer",
      background: on ? "#22C55E" : "#333", position: "relative", transition: "background 0.3s"
    }),
    toggleDot: (on) => ({
      width: 22, height: 22, borderRadius: "50%", background: "#fff",
      position: "absolute", top: 3, left: on ? 27 : 3, transition: "left 0.3s"
    }),
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0A", fontFamily: "'Courier New', monospace", color: "#E5E5E5", position: "relative" }}>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)" }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 800, margin: "0 auto", padding: "0 16px" }}>

        {/* HEADER */}
        <header style={{ padding: "32px 0 24px", borderBottom: "3px solid #FBBF24", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}>
            <div style={{ width: 56, height: 56, borderRadius: 8, background: "#FBBF24",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0 }}>🚍</div>
            <div>
              <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0, color: "#FBBF24", letterSpacing: 2, textTransform: "uppercase", lineHeight: 1.1 }}>HOY NO HAY BONDI</h1>
              <p style={{ margin: 0, fontSize: 12, color: "#A3A3A3", letterSpacing: 3, textTransform: "uppercase" }}>Monitor de paros · Zona Norte GBA + CABA Norte</p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: loading ? "#FBBF24" : "#22C55E", animation: loading ? "pulse 1s infinite" : "none" }} />
                <span style={{ fontSize: 11, color: "#A3A3A3" }}>{loading ? (retryAttempt > 0 ? `Reintentando (${retryAttempt}/2)...` : "Consultando...") : fmt(lastUpdate)}</span>
                {provider && (
                  <span style={{
                    fontSize: 9, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase",
                    padding: "2px 6px", borderRadius: 4,
                    background: provider === "openai" ? "#10A37F22" : provider === "gemini" ? "#4285F422" : "#D4A27422",
                    color: provider === "openai" ? "#10A37F" : provider === "gemini" ? "#4285F4" : "#D4A274",
                    border: `1px solid ${provider === "openai" ? "#10A37F44" : provider === "gemini" ? "#4285F444" : "#D4A27444"}`
                  }}>{provider === "openai" ? "ChatGPT" : provider === "gemini" ? "Gemini" : "Claude"}</span>
                )}
              </div>
              {countdown && notificationsEnabled && <span style={{ fontSize: 10, color: "#525252", background: "#1A1A1A", padding: "2px 8px", borderRadius: 4 }}>próx: {countdown}</span>}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setShowSources(p => !p)} style={{
                background: showSources ? "#FBBF24" : "#1A1A1A", color: showSources ? "#0A0A0A" : "#737373",
                border: "1px solid #333", borderRadius: 6, padding: "8px 12px", fontSize: 13, cursor: "pointer", fontFamily: "'Courier New', monospace"
              }}>📡</button>
              <button onClick={() => setShowNotifPanel(p => !p)} style={{
                background: showNotifPanel ? "#FBBF24" : notificationsEnabled ? "#1A3A1A" : "#1A1A1A",
                color: showNotifPanel ? "#0A0A0A" : notificationsEnabled ? "#22C55E" : "#737373",
                border: `1px solid ${notificationsEnabled ? "#22C55E55" : "#333"}`,
                borderRadius: 6, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "'Courier New', monospace", position: "relative"
              }}>
                🔔
                {notifHistory.length > 0 && <span style={{ position: "absolute", top: -4, right: -4, width: 16, height: 16, background: "#DC2626", borderRadius: "50%", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700 }}>{Math.min(notifHistory.length, 9)}</span>}
              </button>
              <button onClick={() => checkBusStatus()} disabled={loading} style={{
                background: loading ? "#333" : "#FBBF24", color: "#0A0A0A", border: "none", borderRadius: 6,
                padding: "8px 20px", fontSize: 13, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "'Courier New', monospace", textTransform: "uppercase", letterSpacing: 1, opacity: loading ? 0.5 : 1
              }}>{loading ? "⏳" : "🔄"} Actualizar</button>
            </div>
          </div>
        </header>

        {/* SOURCES PANEL */}
        {showSources && (
          <div style={S.panel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 15, color: "#FBBF24", fontWeight: 800, letterSpacing: 1 }}>📡 FUENTES MONITOREADAS</h3>
              <button onClick={() => setShowSources(false)} style={{ background: "none", border: "none", color: "#666", fontSize: 18, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
              {PRIORITY_SOURCES.map((src, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: "#0A0A0A", borderRadius: 8, padding: "10px 14px", border: src.principal ? "1px solid #FBBF24" : "1px solid #1A1A1A" }}>
                  <span style={{ fontSize: 18 }}>{src.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: src.principal ? "#FBBF24" : "#E5E5E5" }}>
                      {src.name}
                      {src.principal && <span style={{ marginLeft: 6, fontSize: 9, background: "#FBBF24", color: "#0A0A0A", padding: "1px 5px", borderRadius: 3, fontWeight: 900 }}>PPAL</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "#666" }}>{src.domain}</div>
                  </div>
                </div>
              ))}
            </div>
            {results?.fuentes_consultadas?.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #1A1A1A" }}>
                <span style={{ fontSize: 10, color: "#525252", textTransform: "uppercase", letterSpacing: 2 }}>Usadas:</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {results.fuentes_consultadas.map((f, i) => <span key={i} style={{ background: "#1A1A1A", border: "1px solid #262626", borderRadius: 4, padding: "3px 8px", fontSize: 11, color: "#A3A3A3" }}>{f}</span>)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* NOTIF PANEL */}
        {showNotifPanel && (
          <div style={{ ...S.panel, border: "1px solid #FBBF2444" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 15, color: "#FBBF24", fontWeight: 800 }}>🔔 NOTIFICACIONES</h3>
              <button onClick={() => setShowNotifPanel(false)} style={{ background: "none", border: "none", color: "#666", fontSize: 18, cursor: "pointer" }}>✕</button>
            </div>
            <div style={S.row}>
              <div><span style={{ fontSize: 13, color: "#E5E5E5" }}>Push notifications</span><p style={{ margin: "4px 0 0", fontSize: 11, color: "#666" }}>Alertas de paros y levantamientos</p></div>
              <button onClick={() => { if (!notificationsEnabled) requestNotifPermission(); else { setNotificationsEnabled(false); addNotifHistory("🔕 Off"); } }} style={S.toggle(notificationsEnabled)}><div style={S.toggleDot(notificationsEnabled)} /></button>
            </div>
            <div style={{ background: "#0A0A0A", borderRadius: 8, padding: "12px 16px", marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: "#E5E5E5", display: "block", marginBottom: 8 }}>Auto-refresh</span>
              <div style={{ display: "flex", gap: 6 }}>
                {REFRESH_OPTIONS.map(opt => <button key={opt.value} onClick={() => setAutoRefreshMin(opt.value)} style={S.btnSmall(autoRefreshMin === opt.value)}>{opt.label}</button>)}
              </div>
            </div>
            <div style={S.row}>
              <div><span style={{ fontSize: 13, color: "#E5E5E5" }}>Solo favoritas</span><p style={{ margin: "4px 0 0", fontSize: 11, color: "#666" }}>{favoriteLines.length > 0 ? favoriteLines.join(", ") : "Marcá ⭐"}</p></div>
              <button onClick={() => setNotifyOnlyFavorites(p => !p)} disabled={!favoriteLines.length} style={{ ...S.toggle(notifyOnlyFavorites), opacity: favoriteLines.length ? 1 : 0.4 }}><div style={S.toggleDot(notifyOnlyFavorites)} /></button>
            </div>
            <div style={{ background: "#0A0A0A", borderRadius: 8, padding: "12px 16px", marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: "#E5E5E5", display: "block", marginBottom: 8 }}>⭐ Favoritas</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {POPULAR_LINES.map(line => <button key={line} onClick={() => toggleFavorite(line)} style={S.btnSmall(favoriteLines.includes(line))}>{line}</button>)}
              </div>
            </div>
            <div style={{ maxHeight: 180, overflowY: "auto" }}>
              <span style={{ fontSize: 10, color: "#525252", textTransform: "uppercase", letterSpacing: 2, display: "block", marginBottom: 8 }}>Historial</span>
              {!notifHistory.length ? <p style={{ fontSize: 12, color: "#444", margin: 0 }}>Sin alertas</p> :
                notifHistory.map((n, i) => <div key={i} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: "1px solid #1A1A1A", fontSize: 12 }}>
                  <span style={{ color: "#525252", flexShrink: 0 }}>{n.time}</span><span style={{ color: "#A3A3A3" }}>{n.text}</span>
                </div>)}
            </div>
          </div>
        )}

        {/* LOADING */}
        {loading && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ width: 64, height: 64, margin: "0 auto 20px", border: "4px solid #333", borderTop: `4px solid ${retryAttempt > 0 ? "#D97706" : "#FBBF24"}`, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <p style={{ color: retryAttempt > 0 ? "#D97706" : "#FBBF24", fontSize: 14, letterSpacing: 2 }}>
              {retryAttempt > 0 ? `REINTENTANDO (${retryAttempt}/2)...` : "CONSULTANDO FUENTES..."}
            </p>
            {retryAttempt > 0 && <p style={{ color: "#666", fontSize: 11, margin: "4px 0 12px" }}>La consulta anterior falló, reintentando automáticamente</p>}
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 16 }}>
              {PRIORITY_SOURCES.slice(0, 6).map((s, i) => <span key={i} style={{ fontSize: 11, color: "#525252", background: "#141414", padding: "3px 8px", borderRadius: 4, animation: `fadeInOut 2s ${i * 0.3}s infinite` }}>{s.icon} {s.name}</span>)}
            </div>
          </div>
        )}

        {/* ERROR */}
        {error && !loading && (
          <div style={{ background: "#371520", border: "1px solid #DC2626", borderRadius: 8, padding: 20, marginBottom: 20 }}>
            <p style={{ color: "#FCA5A5", margin: 0, fontSize: 14 }}>⚠️ {error}</p>
            <button onClick={() => checkBusStatus()} style={{ marginTop: 12, background: "#DC2626", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontFamily: "'Courier New', monospace", fontSize: 12 }}>🔄 Reintentar</button>
            {debugInfo && <p style={{ marginTop: 10, fontSize: 10, color: "#888" }}>Debug: {debugInfo}</p>}
          </div>
        )}

        {/* GEMINI FALLBACK NOTICE */}
        {!loading && provider === "gemini" && (
          <div style={{ background: "#4285F415", border: "1px solid #4285F444", borderRadius: 8, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>🔄</span>
            <div>
              <p style={{ margin: 0, fontSize: 12, color: "#4285F4", fontWeight: 700 }}>Usando Gemini (fallback)</p>
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "#888" }}>Los créditos de Anthropic se agotaron. Datos obtenidos via Google Gemini con búsqueda web.</p>
            </div>
          </div>
        )}

        {/* OPENAI FALLBACK NOTICE */}
        {!loading && provider === "openai" && (
          <div style={{ background: "#10A37F15", border: "1px solid #10A37F44", borderRadius: 8, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>🔄</span>
            <div>
              <p style={{ margin: 0, fontSize: 12, color: "#10A37F", fontWeight: 700 }}>Usando ChatGPT (fallback)</p>
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "#888" }}>Los créditos de Anthropic y Gemini se agotaron. Datos obtenidos via ChatGPT con búsqueda web.</p>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {!loading && results && (
          <>
            {/* BANNER */}
            <div style={{
              background: results.hay_paros ? "linear-gradient(135deg, #7F1D1D, #991B1B)" : "linear-gradient(135deg, #14532D, #166534)",
              borderRadius: 12, padding: 24, marginBottom: 20,
              border: results.hay_paros ? "1px solid #DC2626" : "1px solid #22C55E", position: "relative", overflow: "hidden"
            }}>
              <div style={{ position: "absolute", top: -20, right: -20, fontSize: 100, opacity: 0.08 }}>{results.hay_paros ? "🚫" : "✅"}</div>
              <div style={{ fontSize: 36, marginBottom: 8 }}>{results.hay_paros ? "🚫" : "✅"}</div>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: results.hay_paros ? "#FCA5A5" : "#86EFAC", textTransform: "uppercase", letterSpacing: 2 }}>
                {results.hay_paros ? `${affectedCount} línea${affectedCount !== 1 ? "s" : ""} afectada${affectedCount !== 1 ? "s" : ""}` : "Sin paros reportados"}
              </h2>
              {liftedCount > 0 && <p style={{ margin: "8px 0 0", fontSize: 14, color: "#C4B5FD", fontWeight: 700 }}>🟢 {liftedCount} paro{liftedCount > 1 ? "s" : ""} levantado{liftedCount > 1 ? "s" : ""}</p>}
              <p style={{ margin: "10px 0 0", fontSize: 14, color: "#D4D4D4", lineHeight: 1.6, maxWidth: 600 }}>{results.resumen_general}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
                {results.confiabilidad && <span style={{ background: "rgba(0,0,0,0.3)", borderRadius: 20, padding: "4px 12px", fontSize: 11, color: results.confiabilidad === "alta" ? "#22C55E" : results.confiabilidad === "media" ? "#FBBF24" : "#EF4444" }}>Confiabilidad: {results.confiabilidad.toUpperCase()}</span>}
                {results.fuentes_consultadas?.length > 0 && <span style={{ background: "rgba(0,0,0,0.3)", borderRadius: 20, padding: "4px 12px", fontSize: 11, color: "#A3A3A3" }}>📡 {results.fuentes_consultadas.length} fuentes</span>}
              </div>
            </div>

            {/* TABS */}
            <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "2px solid #262626", overflowX: "auto" }}>
              {tabDefs.map(tab => <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
                background: activeTab === tab.id ? "#FBBF24" : "transparent", color: activeTab === tab.id ? "#0A0A0A" : "#A3A3A3",
                border: "none", borderBottom: activeTab === tab.id ? "2px solid #FBBF24" : "2px solid transparent",
                padding: "10px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Courier New', monospace",
                textTransform: "uppercase", letterSpacing: 1, borderRadius: "6px 6px 0 0", whiteSpace: "nowrap"
              }}>{tab.label}</button>)}
            </div>

            {/* TAB: LÍNEAS */}
            {activeTab === "resumen" && (<>
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "stretch" }}>
                <div style={{ flex: "1 1 180px", display: "flex", alignItems: "center", background: "#141414", border: "1px solid #262626", borderRadius: 8, padding: "0 12px", gap: 8 }}>
                  <span style={{ fontSize: 16, color: "#666" }}>🔍</span>
                  <input value={filterText} onChange={e => setFilterText(e.target.value)} placeholder="Buscar línea..."
                    style={{ background: "none", border: "none", outline: "none", color: "#E5E5E5", fontSize: 13, padding: "10px 0", fontFamily: "'Courier New', monospace", width: "100%" }} />
                  {filterText && <button onClick={() => setFilterText("")} style={{ background: "none", border: "none", color: "#666", fontSize: 14, cursor: "pointer" }}>✕</button>}
                </div>
                <div style={{ display: "flex", alignItems: "center", background: "#141414", border: "1px solid #262626", borderRadius: 8, overflow: "hidden" }}>
                  {[{ id: "all", label: "Todos" }, { id: "paro_total", label: "🚫" }, { id: "paro_parcial", label: "⚠️" }, { id: "demoras", label: "🕐" }, { id: "levantado", label: "🟢" }, { id: "normal", label: "✅" }].map(s =>
                    <button key={s.id} onClick={() => setFilterStatus(s.id)} style={{
                      background: filterStatus === s.id ? "#262626" : "transparent", color: filterStatus === s.id ? (STATUS_MAP[s.id]?.color || "#A3A3A3") : "#555",
                      border: "none", padding: "10px 10px", fontSize: 13, cursor: "pointer", fontFamily: "'Courier New', monospace", borderRight: "1px solid #1A1A1A"
                    }}>{s.label}</button>)}
                </div>
                {favoriteLines.length > 0 && <button onClick={() => setShowFilterPanel(p => !p)} style={{
                  background: showFilterPanel ? "#FBBF24" : "#141414", color: showFilterPanel ? "#0A0A0A" : "#FBBF24",
                  border: "1px solid #FBBF2444", borderRadius: 8, padding: "10px 14px", cursor: "pointer", fontSize: 13, fontFamily: "'Courier New', monospace"
                }}>⭐ {favoriteLines.length}</button>}
              </div>
              {showFilterPanel && favoriteLines.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16, padding: "12px 16px", background: "#111", borderRadius: 8, border: "1px solid #262626" }}>
                  {favoriteLines.map(line => <button key={line} onClick={() => setFilterText(line)} style={{
                    padding: "4px 12px", fontSize: 12, fontWeight: 700, background: filterText === line ? "#FBBF24" : "#1A1A1A",
                    color: filterText === line ? "#0A0A0A" : "#FBBF24", border: "1px solid #FBBF2433", borderRadius: 20, cursor: "pointer", fontFamily: "'Courier New', monospace"
                  }}>⭐ {line}</button>)}
                  <button onClick={() => { setFilterText(""); setShowFilterPanel(false); }} style={{ padding: "4px 12px", fontSize: 11, background: "#1A1A1A", color: "#666", border: "1px solid #262626", borderRadius: 20, cursor: "pointer" }}>Limpiar</button>
                </div>
              )}
              <div style={{ fontSize: 11, color: "#525252", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                {filteredLines.length} resultado{filteredLines.length !== 1 ? "s" : ""}{filterText && ` para "${filterText}"`}
              </div>
              {filteredLines.length > 0 ? filteredLines.map((linea, i) => {
                const st = STATUS_MAP[linea.estado] || STATUS_MAP.normal;
                const isFav = favoriteLines.includes(String(linea.linea));
                return (
                  <div key={i} style={{
                    background: linea.estado === "levantado" ? "#0F0A1E" : "#141414",
                    border: `1px solid ${st.color}33`, borderLeft: `4px solid ${st.color}`, borderRadius: 8, padding: 20, marginBottom: 12
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <div style={{ background: st.color, color: "#fff", fontWeight: 900, fontSize: 16, padding: "6px 14px", borderRadius: 6, minWidth: 50, textAlign: "center" }}>{linea.linea}</div>
                        <span style={{ background: `${st.color}22`, color: st.color, padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 800, textTransform: "uppercase" }}>{st.icon} {st.label}</span>
                        {linea.empresa && <span style={{ fontSize: 10, color: "#666", background: "#1A1A1A", padding: "3px 8px", borderRadius: 4 }}>{linea.empresa}</span>}
                      </div>
                      <button onClick={() => toggleFavorite(String(linea.linea))} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", filter: isFav ? "none" : "grayscale(1) opacity(0.3)" }}>⭐</button>
                    </div>
                    {linea.motivo && <p style={{ margin: "0 0 8px", fontSize: 14, color: "#D4D4D4", lineHeight: 1.5 }}>{linea.motivo}</p>}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#A3A3A3" }}>
                      {linea.desde && <span>🕐 {linea.desde}{linea.hasta ? ` → ${linea.hasta}` : ""}</span>}
                      {linea.zonas?.length > 0 && <span>📍 {linea.zonas.join(", ")}</span>}
                      {linea.fuente && <span>📰 {linea.fuente}</span>}
                    </div>
                  </div>
                );
              }) : <div style={{ textAlign: "center", padding: 40, color: "#666" }}><span style={{ fontSize: 48, display: "block", marginBottom: 12 }}>{filterText || filterStatus !== "all" ? "🔍" : "🎉"}</span>{filterText || filterStatus !== "all" ? "Sin resultados" : "No hay líneas afectadas"}</div>}
            </>)}

            {/* TAB: LEVANTADOS */}
            {activeTab === "levantados" && (<div>
              {results.lineas_afectadas?.filter(l => l.estado === "levantado").map((l, i) => (
                <div key={`la-${i}`} style={{ background: "#0F0A1E", border: "1px solid #8B5CF633", borderLeft: "4px solid #8B5CF6", borderRadius: 8, padding: 20, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <div style={{ background: "#8B5CF6", color: "#fff", fontWeight: 900, fontSize: 16, padding: "6px 14px", borderRadius: 6, minWidth: 50, textAlign: "center" }}>{l.linea}</div>
                    <span style={{ background: "#8B5CF622", color: "#8B5CF6", padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 800, textTransform: "uppercase" }}>🟢 LEVANTADO</span>
                    {l.empresa && <span style={{ fontSize: 10, color: "#666", background: "#1A1A1A", padding: "3px 8px", borderRadius: 4 }}>{l.empresa}</span>}
                  </div>
                  {l.motivo && <p style={{ margin: "0 0 8px", fontSize: 14, color: "#D4D4D4", lineHeight: 1.5 }}>{l.motivo}</p>}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#A3A3A3" }}>
                    {l.desde && <span>🕐 {l.desde}{l.hasta ? ` → ${l.hasta}` : ""}</span>}
                    {l.fuente && <span>📰 {l.fuente}</span>}
                  </div>
                </div>
              ))}
              {results.paros_levantados?.map((pl, i) => (
                <div key={`pl-${i}`} style={{ background: "#0A1E0F", border: "1px solid #22C55E33", borderLeft: "4px solid #22C55E", borderRadius: 8, padding: 20, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <div style={{ background: "#22C55E", color: "#fff", fontWeight: 900, fontSize: 16, padding: "6px 14px", borderRadius: 6, minWidth: 50, textAlign: "center" }}>{pl.linea}</div>
                    <span style={{ background: "#22C55E22", color: "#22C55E", padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 800, textTransform: "uppercase" }}>✅ {pl.servicio_normalizado ? "NORMALIZADO" : "RESTABLECIÉNDOSE"}</span>
                    {pl.empresa && <span style={{ fontSize: 10, color: "#666", background: "#1A1A1A", padding: "3px 8px", borderRadius: 4 }}>{pl.empresa}</span>}
                  </div>
                  <p style={{ margin: "0 0 8px", fontSize: 14, color: "#D4D4D4", lineHeight: 1.5 }}>{pl.detalle}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#A3A3A3" }}>
                    {pl.hora_levantamiento && <span>🕐 Levantado: {pl.hora_levantamiento}</span>}
                    {pl.fuente && <span>📰 {pl.fuente}</span>}
                  </div>
                </div>
              ))}
              {!results.lineas_afectadas?.some(l => l.estado === "levantado") && !results.paros_levantados?.length && (
                <div style={{ textAlign: "center", padding: 40, color: "#666" }}><span style={{ fontSize: 48, display: "block", marginBottom: 12 }}>📋</span>No hay levantamientos reportados hoy</div>
              )}
            </div>)}

            {/* TAB: NOTICIAS */}
            {activeTab === "noticias" && (<div>
              {results.info_general?.length > 0 ? results.info_general.map((news, i) => (
                <div key={i} style={{ background: "#141414", border: "1px solid #262626", borderRadius: 8, padding: 20, marginBottom: 12 }}>
                  <h4 style={{ margin: "0 0 8px", color: "#FBBF24", fontSize: 14, fontWeight: 700 }}>📰 {news.titulo}</h4>
                  <p style={{ margin: "0 0 8px", fontSize: 13, color: "#D4D4D4", lineHeight: 1.5 }}>{news.detalle}</p>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {news.fuente && <span style={{ fontSize: 11, color: "#737373" }}>Fuente: {news.fuente}</span>}
                    {news.url && <a href={news.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "#FBBF24", textDecoration: "none" }}>🔗 Ver nota →</a>}
                  </div>
                </div>
              )) : <div style={{ textAlign: "center", padding: 40, color: "#666" }}>Sin noticias adicionales</div>}
            </div>)}

            {/* TAB: PRÓXIMAS */}
            {activeTab === "proximas" && results.proximas_medidas && (<div>
              {results.proximas_medidas.map((pm, i) => (
                <div key={i} style={{ background: "#1A1414", border: "1px solid #D9770633", borderLeft: "4px solid #D97706", borderRadius: 8, padding: 20, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <span style={{ background: "#D97706", color: "#fff", padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 800 }}>📅 {pm.fecha}</span>
                    <span style={{ fontSize: 12, color: "#FBBF24", fontWeight: 700, textTransform: "uppercase" }}>{pm.tipo}</span>
                  </div>
                  {pm.convocante && <p style={{ margin: "0 0 6px", fontSize: 13, color: "#E5E5E5", fontWeight: 700 }}>Convoca: {pm.convocante}</p>}
                  <p style={{ margin: "0 0 8px", fontSize: 13, color: "#D4D4D4", lineHeight: 1.5 }}>{pm.detalle}</p>
                  {pm.fuente && <span style={{ fontSize: 11, color: "#737373" }}>📰 {pm.fuente}</span>}
                </div>
              ))}
            </div>)}

            {results.nota && <div style={{ background: "#1A1A2E", border: "1px solid #312E81", borderRadius: 8, padding: 16, marginTop: 20, fontSize: 12, color: "#A5B4FC", lineHeight: 1.5 }}>ℹ️ {results.nota}</div>}
          </>
        )}

        {/* FALLBACK */}
        {!loading && !results && rawSummary && (
          <div style={{ background: "#141414", border: "1px solid #333", borderRadius: 8, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{ fontSize: 24 }}>⚠️</span>
              <div>
                <p style={{ margin: 0, fontSize: 14, color: "#FBBF24", fontWeight: 700 }}>Error procesando respuesta</p>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "#888" }}>Intentá actualizar de nuevo</p>
              </div>
            </div>
            <button onClick={() => checkBusStatus()} style={{ background: "#FBBF24", color: "#0A0A0A", border: "none", borderRadius: 6, padding: "8px 20px", fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "'Courier New', monospace", marginBottom: 16 }}>🔄 Reintentar</button>
            {debugInfo && <p style={{ fontSize: 10, color: "#888", marginBottom: 8 }}>Debug: {debugInfo}</p>}
            <details style={{ fontSize: 12, color: "#666" }}>
              <summary style={{ cursor: "pointer", color: "#888", marginBottom: 8 }}>Ver respuesta cruda</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, color: "#555", maxHeight: 300, overflow: "auto", background: "#0A0A0A", padding: 12, borderRadius: 6 }}>{rawSummary}</pre>
            </details>
          </div>
        )}

        {/* ZONES */}
        <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid #262626" }}>
          <p style={{ fontSize: 10, color: "#525252", textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 }}>Zonas monitoreadas</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ZONES.map(z => <span key={z} style={{ background: "#1A1A1A", border: "1px solid #262626", borderRadius: 4, padding: "4px 10px", fontSize: 11, color: "#737373" }}>{z}</span>)}
          </div>
        </div>

        {/* FOOTER */}
        <footer style={{ padding: "24px 0 32px", marginTop: 24, borderTop: "1px solid #1A1A1A", textAlign: "center" }}>
          <p style={{ fontSize: 10, color: "#404040", margin: 0 }}>HOY NO HAY BONDI · Datos de fuentes públicas · No oficial</p>
          <p style={{ fontSize: 10, color: "#333", margin: "4px 0 0" }}>Fuentes: TN · @CiudadDeBondis · parodebondis.com.ar</p>
          <p style={{ fontSize: 11, color: "#FBBF24", margin: "16px 0 0", letterSpacing: 1, fontWeight: 600 }}>Diseñado por Manuel Gonzalo Fariña Serra</p>
        </footer>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeInOut { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0A0A0A; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
      `}</style>
    </div>
  );
}
