import React, { useEffect, useMemo, useRef, useState } from "react";

type BeginMsg = {
  type: "begin";
  room: string;
  userId: string;
  color: string;
  width: number;
  p: [number, number];
};

type MoveMsg = {
  type: "move";
  room: string;
  userId: string;
  pts: [number, number][];
};

type EndMsg = {
  type: "end";
  room: string;
  userId: string;
};

type JoinMsg = { type: "join"; room: string; userId: string };
type HistoryMsg = {
  type: "history";
  room: string;
  events: (BeginMsg | MoveMsg | EndMsg)[];
};

type AnyMsg = BeginMsg | MoveMsg | EndMsg | JoinMsg | HistoryMsg;

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

type StrokeState = {
  drawing: boolean;
  last?: [number, number];
};

export default function CollaborativeCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  // 원격 사용자별 현재 스트로크 상태(마지막 좌표 기억)
  const remoteStrokeRef = useRef<Map<string, StrokeState>>(new Map());

  // 로컬 드로잉 상태
  const localDrawingRef = useRef(false);
  const localLastRef = useRef<[number, number] | null>(null);

  // move를 배치로 보내기 위한 버퍼
  const moveBufferRef = useRef<[number, number][]>([]);
  const flushTimerRef = useRef<number | null>(null);

  const [room, setRoom] = useState("room1");
  const [connected, setConnected] = useState(false);

  // 펜 설정
  const [color, setColor] = useState("#111111");
  const [width, setWidth] = useState(2);

  const userId = useMemo(() => uid(), []);

  function setupCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = 900;
    const cssH = 520;

    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctxRef.current = ctx;
    ctxRef.current.clearRect(0, 0, cssW, cssH);
  }

  function getCanvasPoint(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return [x, y];
  }

  function applyBegin(ctx: CanvasRenderingContext2D, msg: BeginMsg) {
    ctx.strokeStyle = msg.color;
    ctx.lineWidth = msg.width;
    ctx.beginPath();
    ctx.moveTo(msg.p[0], msg.p[1]);
  }

  function applyMove(ctx: CanvasRenderingContext2D, from: [number, number] | undefined, pts: [number, number][]) {
    // from이 없으면 첫 점에서 시작
    if (!pts.length) return;
    if (!from) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }

  function flushMoveBuffer() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (moveBufferRef.current.length === 0) return;

    const payload: MoveMsg = {
      type: "move",
      room,
      userId,
      pts: moveBufferRef.current.splice(0),
    };
    ws.send(JSON.stringify(payload));
  }

  function scheduleFlush() {
    if (flushTimerRef.current != null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushMoveBuffer();
    }, 20); // 20ms마다 묶어서 전송 (네트워크/CPU 균형)
  }

  function connectWs(currentRoom: string) {
    // 1) 배포/로컬 공용: Vercel(Vite) 환경변수에서 WS 주소 가져오기
    const WS_URL = import.meta.env.VITE_WS_URL;

    // 배포에서 이 값이 없으면 조용히 localhost로 떨어지지 말고 즉시 실패하게
    if (!WS_URL) {
        throw new Error("VITE_WS_URL is not defined. Set it in Vercel env vars.");
    }

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
        setConnected(true);
        const join: JoinMsg = { type: "join", room: currentRoom, userId };
        ws.send(JSON.stringify(join));
    };

    ws.onclose = () => {
        setConnected(false);
    };

    ws.onmessage = (ev) => {
        let msg: AnyMsg;
        try {
        msg = JSON.parse(ev.data);
        } catch {
        return;
        }

        const ctx = ctxRef.current;
        if (!ctx) return;

        if (msg.type === "history") {
        remoteStrokeRef.current.clear();
        for (const e of msg.events) handleRemoteEvent(e);
        return;
        }

        handleRemoteEvent(msg);
    };
    }

  function handleRemoteEvent(msg: BeginMsg | MoveMsg | EndMsg | JoinMsg) {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const states = remoteStrokeRef.current;
    const st = states.get(msg.userId) ?? { drawing: false };

    if (msg.type === "begin") {
      applyBegin(ctx, msg);
      st.drawing = true;
      st.last = msg.p;
      states.set(msg.userId, st);
      return;
    }

    if (msg.type === "move") {
      if (!st.drawing) {
        // begin을 놓쳤거나 순서 뒤틀림 대비: 첫 점부터 시작
        st.drawing = true;
      }
      applyMove(ctx, st.last, msg.pts);
      st.last = msg.pts[msg.pts.length - 1];
      states.set(msg.userId, st);
      return;
    }

    if (msg.type === "end") {
      st.drawing = false;
      st.last = undefined;
      states.set(msg.userId, st);
    }
  }

  // 초기 캔버스 세팅 + WS 연결
  useEffect(() => {
    setupCanvas();
    connectWs(room);
    return () => {
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // room 변경시: 서버 재접속 + 캔버스 초기화
  const changeRoom = () => {
    wsRef.current?.close();
    setupCanvas();
    connectWs(room);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    const ws = wsRef.current;
    if (!canvas || !ctx || !ws || ws.readyState !== WebSocket.OPEN) return;

    canvas.setPointerCapture(e.pointerId);

    localDrawingRef.current = true;
    const p = getCanvasPoint(e);
    localLastRef.current = p;

    // 로컬 draw
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);

    // 네트워크 send
    const msg: BeginMsg = { type: "begin", room, userId, color, width, p };
    ws.send(JSON.stringify(msg));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!localDrawingRef.current) return;
    const ctx = ctxRef.current;
    if (!ctx) return;

    const p = getCanvasPoint(e);
    const last = localLastRef.current;

    // 로컬 draw (즉시 반응)
    if (last) {
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    localLastRef.current = p;

    // 네트워크는 배치로
    moveBufferRef.current.push(p);
    scheduleFlush();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!localDrawingRef.current) return;
    const canvas = canvasRef.current;
    const ws = wsRef.current;
    if (!canvas || !ws || ws.readyState !== WebSocket.OPEN) return;

    localDrawingRef.current = false;
    localLastRef.current = null;

    // 남은 move flush 후 end
    flushMoveBuffer();
    const msg: EndMsg = { type: "end", room, userId };
    ws.send(JSON.stringify(msg));

    canvas.releasePointerCapture(e.pointerId);
  };

  const clearLocal = () => {
    // 가장 단순한 예시는 "로컬 캔버스만" 지우기
    // 진짜 협업에서는 clear도 이벤트로 보내야 함(type:"clear")
    setupCanvas();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span>
          상태: {connected ? "🟢 연결됨" : "🔴 끊김"} / userId: {userId.slice(0, 6)}
        </span>

        <label>
          Room:
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            style={{ marginLeft: 8 }}
          />
        </label>
        <button onClick={changeRoom}>Join room</button>

        <label style={{ marginLeft: 12 }}>
          Color:
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>

        <label>
          Width:
          <input
            type="range"
            min={1}
            max={12}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
          {width}
        </label>

        <button onClick={clearLocal}>Clear (local)</button>
      </div>

      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          border: "1px solid #ccc",
          borderRadius: 12,
          touchAction: "none", // 모바일에서 스크롤 대신 드로잉 되게
          background: "white",
        }}
      />
    </div>
  );
}
