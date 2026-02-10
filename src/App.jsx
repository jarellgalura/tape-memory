import { useEffect, useMemo, useRef, useState } from "react";

export default function App() {
    const knobRef = useRef(null);
    const canvasRef = useRef(null);

    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [angle, setAngle] = useState(0);

    // Pick one:
    const SOUND_MODE = "TAPE"; // "TAPE" | "RADIO"

    const lastAngleRef = useRef(0);
    const velocityRef = useRef(0); // raw speed from knob
    const tapeSpeedRef = useRef(0); // smoothed speed applied to playhead
    const rafRef = useRef(null);

    const lastDirRef = useRef(0);

    /* ======================
         WebAudio
      ====================== */
    const ctxRef = useRef(null);
    const analyserRef = useRef(null);
    const analyserDataRef = useRef(null);
    const masterGainRef = useRef(null);

    const bufferRef = useRef(null);
    const bufferRevRef = useRef(null);
    const readyRef = useRef(false);

    // noise layers
    const hissGainRef = useRef(null);
    const squealGainRef = useRef(null);

    // tone chain endpoints
    const toneInRef = useRef(null);

    // radio AM tremolo (optional)
    const amGainRef = useRef(null);
    const amLfoGainRef = useRef(null);

    // scheduler
    const playheadRef = useRef(0);
    const nextGrainTimeRef = useRef(0);
    const initPromiseRef = useRef(null);

    /* ======================
         CONFIG (clarity + control)
      ====================== */
    const DRAG_SENSITIVITY = 0.00038; // base sensitivity
    const REWIND_MULT = 2.0; // ✅ faster rewind (CCW)
    const MAX_PLAY = 0.028; // max forward (play)
    const MAX_REW = 0.06; // max rewind
    const FRICTION = 0.935;
    const DEADZONE = 0.00006;

    const SPEED_SMOOTHING = 0.16;

    // grains
    const GRAIN_SIZE = 0.06;
    const LOOKAHEAD = 0.14;
    const STEP_MIN = 0.016;
    const STEP_MAX = 0.05;

    // wow/flutter (tape-ish)
    const WOW_HZ = 0.38;
    const WOW_DEPTH = 0.0022;
    const FLUTTER_HZ = 5.2;
    const FLUTTER_DEPTH = 0.001;

    /* ======================
         PHOTOS
      ====================== */
    const images = useMemo(
        () => [
            "/PICT0845.jpg",
            "/PICT0828.jpg",
            "/PICT0881.jpg",
            "/PICT0899.jpg",
            "/PICT0836.jpg",
            "/PICT0904.jpg",
            "/PICT0920.jpg",
            "/PICT0802.jpg",
            "/PICT0856.jpg",
            "/PICT0916.jpg",
            "/PICT0888.jpg",
            "/PICT0921.jpg",
        ],
        []
    );

    const handwrittenFont =
        "'Segoe Print','Bradley Hand','Comic Sans MS','Marker Felt',cursive";

    const photoFilter = "sepia(0.18) saturate(0.95) contrast(0.97) brightness(1.02)";

    const daisyAngle = angle * 0.18;

    /* ======================
         Audio init (Tape/Radio tone chain)
      ====================== */
    const ensureAudio = async () => {
        if (initPromiseRef.current) return initPromiseRef.current;

        initPromiseRef.current = (async () => {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();

            // analyser -> master -> destination
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.86;

            const master = ctx.createGain();
            master.gain.value = 1.0;

            analyser.connect(master);
            master.connect(ctx.destination);

            ctxRef.current = ctx;
            analyserRef.current = analyser;
            analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount);
            masterGainRef.current = master;

            /**
             * Tone chain design:
             * toneIn -> HPF -> presence -> (optional AM) -> softSat -> LPF -> analyser
             */
            const toneIn = ctx.createGain();

            // Radio uses stronger band-limit; Tape is wider
            const hpf = ctx.createBiquadFilter();
            hpf.type = "highpass";
            hpf.frequency.value = SOUND_MODE === "RADIO" ? 260 : 90;
            hpf.Q.value = 0.7;

            const presence = ctx.createBiquadFilter();
            presence.type = "peaking";
            presence.frequency.value = SOUND_MODE === "RADIO" ? 2200 : 1700;
            presence.Q.value = SOUND_MODE === "RADIO" ? 1.0 : 0.85;
            presence.gain.value = SOUND_MODE === "RADIO" ? 2.2 : 1.4;

            // AM tremolo (radio only)
            const amGain = ctx.createGain();
            amGain.gain.value = 1.0;
            amGainRef.current = amGain;

            const lfo = ctx.createOscillator();
            lfo.type = "sine";
            lfo.frequency.value = 7.5; // AM wobble speed

            const lfoGain = ctx.createGain();
            lfoGain.gain.value = SOUND_MODE === "RADIO" ? 0.12 : 0.0; // depth
            amLfoGainRef.current = lfoGain;

            // connect lfo -> amGain.gain
            lfo.connect(lfoGain);
            lfoGain.connect(amGain.gain);
            lfo.start();

            // saturation (tape compression vibe)
            const softSat = ctx.createWaveShaper();
            softSat.curve = makeSoftSatCurve(SOUND_MODE === "RADIO" ? 0.4 : 0.55);
            softSat.oversample = "2x";

            // top rolloff (radio narrower)
            const lpf = ctx.createBiquadFilter();
            lpf.type = "lowpass";
            lpf.frequency.value = SOUND_MODE === "RADIO" ? 3600 : 5200;
            lpf.Q.value = 0.7;

            // wire chain
            toneIn.connect(hpf);
            hpf.connect(presence);
            presence.connect(amGain);
            amGain.connect(softSat);
            softSat.connect(lpf);
            lpf.connect(analyser);

            toneInRef.current = toneIn;

            // ----- Tape hiss (looping) -----
            const hissGain = ctx.createGain();
            hissGain.gain.value = SOUND_MODE === "RADIO" ? 0.012 : 0.01;
            hissGainRef.current = hissGain;

            const hiss = makeNoise(ctx, 0.11);
            const hissLP = ctx.createBiquadFilter();
            hissLP.type = "lowpass";
            hissLP.frequency.value = SOUND_MODE === "RADIO" ? 4200 : 6500;

            hiss.connect(hissLP);
            hissLP.connect(hissGain);
            hissGain.connect(toneIn);

            // ----- Rewind squeal -----
            const squealGain = ctx.createGain();
            squealGain.gain.value = 0.0;
            squealGainRef.current = squealGain;

            const squeal = makeNoise(ctx, 0.2);
            const squealBP = ctx.createBiquadFilter();
            squealBP.type = "bandpass";
            squealBP.frequency.value = 2400;
            squealBP.Q.value = 1.1;

            squeal.connect(squealBP);
            squealBP.connect(squealGain);
            squealGain.connect(toneIn);

            // ----- Load audio buffer -----
            const res = await fetch("/audio.mp3", { cache: "no-store" });
            if (!res.ok) throw new Error("Could not load /audio.mp3 (put it in /public).");
            const arr = await res.arrayBuffer();
            const buf = await ctx.decodeAudioData(arr);

            bufferRef.current = buf;
            bufferRevRef.current = reverseBuffer(ctx, buf);
            readyRef.current = true;

            setDuration(buf.duration);
            nextGrainTimeRef.current = ctx.currentTime;
        })();

        return initPromiseRef.current;
    };

    /* ======================
         Angle helpers
      ====================== */
    const getAngle = (x, y) => {
        const r = knobRef.current.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return Math.atan2(y - cy, x - cx) * (180 / Math.PI);
    };

    const normalize = (d) => {
        if (d > 180) return d - 360;
        if (d < -180) return d + 360;
        return d;
    };

    /* ======================
         Mechanical click (direction change)
      ====================== */
    const playClick = () => {
        const ctx = ctxRef.current;
        const toneIn = toneInRef.current;
        if (!ctx || !toneIn) return;

        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.value = 1300;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0, now);
        g.gain.linearRampToValueAtTime(0.06, now + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

        osc.connect(g);
        g.connect(toneIn);

        osc.start(now);
        osc.stop(now + 0.035);

        osc.onended = () => {
            try {
                osc.disconnect();
                g.disconnect();
            } catch { }
        };
    };

    /* ======================
         Pointer
      ====================== */
    const onPointerDown = async (e) => {
        await ensureAudio();
        try {
            await ctxRef.current.resume();
        } catch { }

        const a = getAngle(e.clientX, e.clientY);
        lastAngleRef.current = a;
        knobRef.current.setPointerCapture(e.pointerId);

        nextGrainTimeRef.current = ctxRef.current.currentTime;
    };

    const onPointerMove = (e) => {
        if (!knobRef.current.hasPointerCapture(e.pointerId)) return;
        if (e.cancelable) e.preventDefault();

        const a = getAngle(e.clientX, e.clientY);
        const delta = normalize(a - lastAngleRef.current);
        lastAngleRef.current = a;

        // Visual knob rotation stays natural
        setAngle((prev) => prev + delta);

        // ✅ NEW MAPPING:
        // Clockwise (delta > 0) = PLAY  => positive velocity
        // Counter-clockwise (delta < 0) = REWIND => negative velocity
        const audioDelta = delta;

        // ✅ Faster rewind only (rewind = negative)
        const mult = audioDelta < 0 ? REWIND_MULT : 1;

        velocityRef.current += audioDelta * DRAG_SENSITIVITY * mult;

        // Clamp: rewind is negative, play is positive
        velocityRef.current = clamp(velocityRef.current, -MAX_REW, MAX_PLAY);
    };

    const onPointerUp = (e) => {
        try {
            knobRef.current.releasePointerCapture(e.pointerId);
        } catch { }
    };

    /* ======================
         Canvas (retina)
      ====================== */
    const resizeCanvas = () => {
        const c = canvasRef.current;
        if (!c) return;
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const rect = c.getBoundingClientRect();
        c.width = Math.floor(rect.width * dpr);
        c.height = Math.floor(rect.height * dpr);
    };

    useEffect(() => {
        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);
        return () => window.removeEventListener("resize", resizeCanvas);
    }, []);

    /* ======================
         Graph drawing
      ====================== */
    const drawGraph = () => {
        const c = canvasRef.current;
        const analyser = analyserRef.current;
        const data = analyserDataRef.current;
        if (!c) return;

        const g = c.getContext("2d");
        if (!g) return;

        const w = c.width;
        const h = c.height;

        g.clearRect(0, 0, w, h);
        g.fillStyle = "rgba(241, 237, 230, 1)";
        g.fillRect(0, 0, w, h);

        const v = tapeSpeedRef.current;
        const denom = v >= 0 ? MAX_PLAY : MAX_REW;
        const intensity = Math.min(1, Math.abs(v) / denom);

        const bars = 40;
        const gap = Math.max(2, Math.floor(w * 0.008));
        const barW = Math.max(3, Math.floor((w - gap * (bars + 1)) / bars));
        let values = new Array(bars).fill(0);

        if (analyser && data) {
            analyser.getByteFrequencyData(data);

            const start = Math.floor(data.length * 0.04);
            const end = Math.floor(data.length * 0.35);
            const span = Math.max(1, end - start);

            for (let i = 0; i < bars; i++) {
                const idx = start + Math.floor((i / bars) * span);
                values[i] = clamp((data[idx] / 255) * (0.45 + 0.9 * intensity), 0, 1);
            }
        }

        g.fillStyle = "rgba(43, 38, 33, 0.78)";
        const base = h * 0.78;

        for (let i = 0; i < bars; i++) {
            const x = gap + i * (barW + gap);
            const barH = Math.max(2, values[i] * (h * 0.62));
            const y = base - barH;
            g.fillRect(x, y, barW, barH);
        }

        g.fillStyle = "rgba(250,248,244,0.35)";
        g.fillRect(0, 0, w, Math.max(1, Math.floor(h * 0.08)));
    };

    /* ======================
         Grain scheduling
      ====================== */
    const scheduleGrains = () => {
        const ctx = ctxRef.current;
        const toneIn = toneInRef.current;
        const bufF = bufferRef.current;
        const bufR = bufferRevRef.current;
        if (!ctx || !toneIn || !bufF || !bufR || !readyRef.current) return;

        const now = ctx.currentTime;
        const v = tapeSpeedRef.current;

        // click on direction change
        const dir = v > DEADZONE ? 1 : v < -DEADZONE ? -1 : 0;
        if (dir !== 0 && lastDirRef.current !== 0 && dir !== lastDirRef.current) playClick();
        if (dir !== 0) lastDirRef.current = dir;

        // hiss behavior (more when forward)
        if (hissGainRef.current) {
            if (v > DEADZONE) hissGainRef.current.gain.setTargetAtTime(0.028, now, 0.05);
            else if (v < -DEADZONE) hissGainRef.current.gain.setTargetAtTime(0.016, now, 0.05);
            else hissGainRef.current.gain.setTargetAtTime(0.01, now, 0.08);
        }

        // rewind squeal
        if (squealGainRef.current) {
            if (v < -DEADZONE) {
                const amt = Math.min(0.2, (Math.abs(v) / MAX_REW) * 0.2);
                squealGainRef.current.gain.setTargetAtTime(amt, now, 0.03);
            } else {
                squealGainRef.current.gain.setTargetAtTime(0.0, now, 0.04);
            }
        }

        if (Math.abs(v) <= DEADZONE) return;

        const denom = v >= 0 ? MAX_PLAY : MAX_REW;
        const speedNorm = Math.min(1, Math.abs(v) / denom);
        const step = lerp(STEP_MAX, STEP_MIN, speedNorm);

        if (nextGrainTimeRef.current < now) nextGrainTimeRef.current = now;

        while (nextGrainTimeRef.current < now + LOOKAHEAD) {
            const forward = v > 0;
            const buf = forward ? bufF : bufR;

            let offset = forward ? playheadRef.current : Math.max(0, duration - playheadRef.current);
            offset = clamp(offset, 0, Math.max(0, buf.duration - GRAIN_SIZE));

            const src = ctx.createBufferSource();
            src.buffer = buf;

            // wow/flutter (tape) + tiny drift
            const t = nextGrainTimeRef.current;
            const wow = Math.sin(2 * Math.PI * WOW_HZ * t) * WOW_DEPTH;
            const flutter = Math.sin(2 * Math.PI * FLUTTER_HZ * t) * FLUTTER_DEPTH;
            const randomDrift = (Math.random() - 0.5) * 0.0016;

            src.playbackRate.value = 1 + wow + flutter + randomDrift;

            const g = ctx.createGain();
            g.gain.value = 0;

            src.connect(g);
            g.connect(toneIn);

            const t0 = nextGrainTimeRef.current;
            const attack = 0.012;
            const release = 0.022;
            const sustain = Math.max(0, GRAIN_SIZE - (attack + release));
            const peak = 0.78;

            g.gain.setValueAtTime(0.0, t0);
            g.gain.linearRampToValueAtTime(peak, t0 + attack);
            g.gain.linearRampToValueAtTime(peak, t0 + attack + sustain);
            g.gain.linearRampToValueAtTime(0.0, t0 + attack + sustain + release);

            src.start(t0, offset, GRAIN_SIZE);

            src.onended = () => {
                try {
                    src.disconnect();
                    g.disconnect();
                } catch { }
            };

            nextGrainTimeRef.current += step;
        }
    };

    /* ======================
         Main tick loop
      ====================== */
    useEffect(() => {
        const tick = () => {
            if (readyRef.current && duration) {
                // smooth raw velocity into tape speed
                tapeSpeedRef.current =
                    tapeSpeedRef.current * (1 - SPEED_SMOOTHING) +
                    velocityRef.current * SPEED_SMOOTHING;

                // move playhead using smoothed speed
                playheadRef.current = clamp(playheadRef.current + tapeSpeedRef.current, 0, duration);
                setTime(playheadRef.current);

                // inertia
                velocityRef.current *= FRICTION;

                // damping at ends
                if (playheadRef.current <= 0.0005 || playheadRef.current >= duration - 0.0005) {
                    velocityRef.current *= 0.6;
                    tapeSpeedRef.current *= 0.75;
                }

                scheduleGrains();
            }

            drawGraph();
            rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [duration]);

    /* ======================
         Photos scroll (NO opacity fade; optimized for mobile)
      ====================== */
    const prog = duration ? time / duration : 0;
    const tileW = 140;
    const viewportW = 420 - 48;
    const maxScroll = Math.max(0, images.length * tileW - viewportW);
    const photoOffset = prog * maxScroll;

    return (
        <div className="min-h-[100dvh] bg-[#f4f1ec] flex items-center justify-center p-6 text-[#2b2621]">
            <div className="w-full max-w-[420px] rounded-2xl border border-[#d8d2c8] bg-[#faf8f4] shadow-sm relative overflow-hidden">
                {/* BIG DAISY */}
                <div
                    className="absolute -top-20 -right-20 opacity-90 pointer-events-none"
                    style={{
                        width: 240,
                        height: 240,
                        transform: `rotate(${daisyAngle}deg)`,
                        transition: "transform 140ms linear",
                    }}
                >
                    <DaisyBig />
                </div>

                {/* Header */}
                <div className="px-6 pt-6 pb-4 relative">
                    <p
                        className="text-xs tracking-widest uppercase text-[#7a7268]"
                        style={{ fontFamily: handwrittenFont }}
                    >
                        Audio Memory Hun
                    </p>
                    <h1 className="text-lg font-medium mt-1" style={{ fontFamily: handwrittenFont }}>
                        Tape Recorder
                    </h1>
                    <p className="text-[11px] text-[#7a7268] mt-1" style={{ fontFamily: handwrittenFont }}>
                        Sound: {SOUND_MODE === "RADIO" ? "Radio" : "Tape"}
                    </p>
                </div>

                {/* Progress */}
                <div className="px-6 relative">
                    <div className="h-[2px] bg-[#e0dad0]">
                        <div className="h-[2px] bg-[#2b2621]" style={{ width: `${prog * 100}%` }} />
                    </div>
                    <div
                        className="flex justify-between text-[11px] text-[#7a7268] mt-2"
                        style={{ fontFamily: handwrittenFont }}
                    >
                        <span>{format(time)}</span>
                        <span>{format(duration)}</span>
                    </div>
                </div>

                {/* Photos */}
                <div className="mt-6 overflow-hidden relative">
                    <div
                        className="flex gap-4 px-6"
                        style={{
                            transform: `translate3d(-${photoOffset}px, 0, 0)`,
                            willChange: "transform",
                            WebkitBackfaceVisibility: "hidden",
                            backfaceVisibility: "hidden",
                        }}
                    >
                        {images.map((src, i) => (
                            <div key={i} className="relative shrink-0">
                                <img
                                    src={src}
                                    draggable={false}
                                    className="w-32 h-32 object-cover rounded-md"
                                    style={{
                                        filter: photoFilter,
                                        WebkitTransform: "translateZ(0)",
                                        transform: "translateZ(0)",
                                    }}
                                    alt=""
                                />
                                <div
                                    className="pointer-events-none absolute inset-0 rounded-md"
                                    style={{
                                        background:
                                            "linear-gradient(180deg, rgba(250,248,244,0.10), rgba(43,38,33,0.06))",
                                        mixBlendMode: "multiply",
                                    }}
                                />
                            </div>
                        ))}
                    </div>
                </div>

                {/* Window (audio graph) */}
                <div className="px-6 mt-6 relative">
                    <div className="h-14 rounded-md border border-[#e0dad0] bg-[#f1ede6] overflow-hidden">
                        <canvas ref={canvasRef} className="w-full h-full" />
                    </div>
                </div>

                {/* Knob */}
                <div className="flex justify-center py-10 relative">
                    <div
                        ref={knobRef}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                        className="relative w-28 h-28 rounded-full touch-none select-none"
                        style={{
                            transform: `rotate(${angle}deg)`,
                            background: "#f8f5ef",
                            border: "1px solid #d8d2c8",
                        }}
                    >
                        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-[2px] h-6 bg-[#2b2621]" />
                        <div className="absolute inset-8 rounded-full bg-[#faf8f4] border border-[#e0dad0]" />
                    </div>
                </div>

                <p className="text-center text-xs text-[#7a7268] pb-6 relative" style={{ fontFamily: handwrittenFont }}>
                    Clockwise to play • Counter-clockwise to rewind • Wind slowly for clearer audio
                </p>
            </div>
        </div>
    );
}

/* ======================
   Helpers
====================== */
function clamp(x, a, b) {
    return Math.max(a, Math.min(b, x));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
function format(sec = 0) {
    const s = Math.floor(sec || 0);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
}

/* Tape-ish saturation curve */
function makeSoftSatCurve(amount = 0.5) {
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 2 + amount * 8; // 2..10
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
}

/* Daisy */
function DaisyBig() {
    return (
        <svg width="100%" height="100%" viewBox="0 0 100 100" aria-hidden="true">
            {Array.from({ length: 12 }).map((_, i) => (
                <ellipse
                    key={i}
                    cx="50"
                    cy="18"
                    rx="7"
                    ry="18"
                    fill="#fff"
                    transform={`rotate(${i * 30} 50 50)`}
                />
            ))}
            <circle cx="50" cy="50" r="13" fill="#f5c542" />
            <circle cx="50" cy="50" r="13" fill="none" stroke="rgba(0,0,0,0.06)" />
        </svg>
    );
}

/* Noise source */
function makeNoise(ctx, amp = 0.15) {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * amp;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
}

/* Reverse buffer */
function reverseBuffer(ctx, buf) {
    const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const src = buf.getChannelData(ch);
        const dst = rev.getChannelData(ch);
        for (let i = 0, j = src.length - 1; i < src.length; i++, j--) {
            dst[i] = src[j];
        }
    }
    return rev;
}
