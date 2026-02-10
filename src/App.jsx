import { useEffect, useMemo, useRef, useState } from "react";

export default function App() {
    const knobRef = useRef(null);

    // ✅ TWO CANVASES:
    // 1) Photo strip canvas (pre-rendered, then we just "window" it)
    const photoCanvasRef = useRef(null);
    // 2) Audio graph canvas
    const graphCanvasRef = useRef(null);

    // UI state
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [angle, setAngle] = useState(0);

    // device
    const IS_MOBILE = useMemo(
        () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
        []
    );

    // pointer + physics
    const lastAngleRef = useRef(0);
    const velocityRef = useRef(0); // raw from drag/inertia
    const tapeSpeedRef = useRef(0); // smoothed applied to playhead
    const rafRef = useRef(null);

    // direction click detect
    const lastDirRef = useRef(0);

    // throttle draws (mobile)
    const lastGraphDrawRef = useRef(0);
    const lastPhotoDrawRef = useRef(0);

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

    // scheduler
    const playheadRef = useRef(0);
    const nextGrainTimeRef = useRef(0);
    const initPromiseRef = useRef(null);

    /* ======================
       PERFORMANCE + CLARITY CONFIG
    ====================== */
    // Slower wind => clearer
    const DRAG_SENSITIVITY = 0.00038;
    const MAX_V = 0.028;
    const FRICTION = 0.935;
    const DEADZONE = 0.00006;
    const SPEED_SMOOTHING = 0.16;

    // granular scrub (mobile lighter)
    const GRAIN_SIZE = 0.06;
    const LOOKAHEAD = IS_MOBILE ? 0.08 : 0.14;
    const STEP_MIN = IS_MOBILE ? 0.024 : 0.016;
    const STEP_MAX = 0.05;

    // wow/flutter (mobile lighter)
    const WOW_HZ = 0.38;
    const WOW_DEPTH = IS_MOBILE ? 0.0012 : 0.0022;
    const FLUTTER_HZ = 5.2;
    const FLUTTER_DEPTH = IS_MOBILE ? 0.0006 : 0.0010;

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

    // Your original filter is kept for the UI vibe,
    // but canvas filter is expensive on mobile, so we simplify slightly there.
    const photoFilterCSS =
        "sepia(0.18) saturate(0.95) contrast(0.97) brightness(1.02)";

    const photoFilterCanvas = IS_MOBILE
        ? "sepia(0.12) saturate(0.98)"
        : "sepia(0.18) saturate(0.95) contrast(0.97) brightness(1.02)";

    const daisyAngle = angle * 0.18;

    /* ======================
       PHOTO STRIP PRE-RENDER (Offscreen)
    ====================== */
    const photoStripRef = useRef({
        ready: false,
        dpr: 1,
        tilePx: 0,
        gapPx: 0,
        width: 0,
        height: 0,
        stripCanvas: null, // offscreen
    });

    const PHOTO_TILE = 128; // "w-32 h-32" = 128px
    const PHOTO_GAP = 16; // "gap-4" = 16px

    // Create the offscreen strip once images are loaded
    useEffect(() => {
        let cancelled = false;

        const buildStrip = async () => {
            const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
            const tile = PHOTO_TILE;
            const gap = PHOTO_GAP;

            // Preload images
            const bitmaps = await Promise.all(
                images.map(async (src) => {
                    const img = await loadImage(src);
                    // createImageBitmap is faster for drawImage on many browsers
                    if ("createImageBitmap" in window) {
                        try {
                            return await createImageBitmap(img);
                        } catch {
                            return img;
                        }
                    }
                    return img;
                })
            );

            if (cancelled) return;

            const stripW = images.length * tile + Math.max(0, images.length - 1) * gap;
            const stripH = tile;

            // Offscreen canvas
            const off = document.createElement("canvas");
            off.width = Math.floor(stripW * dpr);
            off.height = Math.floor(stripH * dpr);

            const ctx = off.getContext("2d");
            if (!ctx) return;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";

            // Apply your filter inside the strip (so we don’t filter every frame)
            ctx.filter = photoFilterCanvas;

            // Draw each tile
            for (let i = 0; i < bitmaps.length; i++) {
                const x = i * (tile + gap);
                drawCover(ctx, bitmaps[i], x, 0, tile, tile);
                // subtle overlay like your gradient
                ctx.save();
                ctx.globalCompositeOperation = "multiply";
                const grad = ctx.createLinearGradient(0, 0, 0, tile);
                grad.addColorStop(0, "rgba(250,248,244,0.10)");
                grad.addColorStop(1, "rgba(43,38,33,0.06)");
                ctx.fillStyle = grad;
                roundRect(ctx, x, 0, tile, tile, 8);
                ctx.fill();
                ctx.restore();

                // rounded corners mask effect (clean edges)
                // We can clip per tile (cheap once during render)
                // Already visually rounded from overlay; the main canvas draw will be clean.
            }

            // Reset filter (good practice)
            ctx.filter = "none";

            photoStripRef.current = {
                ready: true,
                dpr,
                tilePx: tile,
                gapPx: gap,
                width: stripW,
                height: stripH,
                stripCanvas: off,
            };
        };

        buildStrip();

        return () => {
            cancelled = true;
        };
    }, [images, photoFilterCanvas]);

    /* ======================
       AUDIO INIT (Tape tone)
    ====================== */
    const ensureAudio = async () => {
        if (initPromiseRef.current) return initPromiseRef.current;

        initPromiseRef.current = (async () => {
            const ctx = new (window.AudioContext || window.webkitAudioContext)({
                // optional: reduce CPU on mobile
                sampleRate: IS_MOBILE ? 32000 : 44100,
            });

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
             * Tape tone chain:
             * toneIn -> HPF -> presence -> saturation -> LPF -> analyser
             */
            const toneIn = ctx.createGain();

            const hpf = ctx.createBiquadFilter();
            hpf.type = "highpass";
            hpf.frequency.value = 90;
            hpf.Q.value = 0.7;

            const presence = ctx.createBiquadFilter();
            presence.type = "peaking";
            presence.frequency.value = 1700;
            presence.Q.value = 0.85;
            presence.gain.value = 1.4;

            const softSat = ctx.createWaveShaper();
            softSat.curve = makeSoftSatCurve(0.55);
            softSat.oversample = "2x";

            const lpf = ctx.createBiquadFilter();
            lpf.type = "lowpass";
            lpf.frequency.value = 5200;
            lpf.Q.value = 0.7;

            toneIn.connect(hpf);
            hpf.connect(presence);
            presence.connect(softSat);
            softSat.connect(lpf);
            lpf.connect(analyser);

            toneInRef.current = toneIn;

            // ----- Tape hiss (looping) -----
            const hissGain = ctx.createGain();
            hissGain.gain.value = 0.010;
            hissGainRef.current = hissGain;

            const hiss = makeNoise(ctx, 0.11);
            const hissLP = ctx.createBiquadFilter();
            hissLP.type = "lowpass";
            hissLP.frequency.value = 6500;

            hiss.connect(hissLP);
            hissLP.connect(hissGain);
            hissGain.connect(toneIn);

            // ----- Rewind squeal -----
            const squealGain = ctx.createGain();
            squealGain.gain.value = 0.0;
            squealGainRef.current = squealGain;

            const squeal = makeNoise(ctx, 0.20);
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
       Mechanical click
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

        // CCW = forward, CW = rewind
        velocityRef.current += delta * DRAG_SENSITIVITY;
        velocityRef.current = clamp(velocityRef.current, -MAX_V, MAX_V);

        setAngle((prev) => prev + delta);
    };

    const onPointerUp = (e) => {
        try {
            knobRef.current.releasePointerCapture(e.pointerId);
        } catch { }
    };

    /* ======================
       Canvas sizing (retina)
    ====================== */
    const resizeCanvasToCSS = (canvas, maxDpr = 2) => {
        if (!canvas) return;
        const dpr = Math.max(1, Math.min(maxDpr, window.devicePixelRatio || 1));
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
    };

    useEffect(() => {
        const onResize = () => {
            resizeCanvasToCSS(photoCanvasRef.current, 2);
            resizeCanvasToCSS(graphCanvasRef.current, 2);
        };
        onResize();
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    /* ======================
       Draw PHOTO viewport from pre-rendered strip
    ====================== */
    const drawPhotos = () => {
        const canvas = photoCanvasRef.current;
        const strip = photoStripRef.current;
        if (!canvas || !strip.ready || !strip.stripCanvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const cssW = canvas.getBoundingClientRect().width;
        const cssH = canvas.getBoundingClientRect().height;

        // background (matches card)
        ctx.clearRect(0, 0, cssW, cssH);

        // Compute scroll based on progress
        const prog = duration ? time / duration : 0;

        // viewport width is canvas width in CSS pixels
        const viewportW = cssW;
        const maxScroll = Math.max(0, strip.width - viewportW);

        // ✅ snap to whole pixels to avoid blur
        const offset = Math.round(prog * maxScroll);

        // subtle fade as time passes
        const photosOpacity = 1 - Math.min(0.18, prog * 0.18);

        // Draw from offscreen strip:
        // source coords are in *offscreen canvas pixels*, so multiply by strip.dpr
        const sx = Math.round(offset * strip.dpr);
        const sy = 0;
        const sw = Math.round(viewportW * strip.dpr);
        const sh = Math.round(strip.height * strip.dpr);

        ctx.save();
        ctx.globalAlpha = photosOpacity;

        // draw onto main photo canvas (destination in CSS pixels)
        ctx.drawImage(
            strip.stripCanvas,
            sx,
            sy,
            sw,
            sh,
            0,
            0,
            viewportW,
            strip.height
        );

        ctx.restore();
    };

    /* ======================
       Draw AUDIO GRAPH (throttled on mobile)
    ====================== */
    const drawGraph = () => {
        const c = graphCanvasRef.current;
        const analyser = analyserRef.current;
        const data = analyserDataRef.current;
        if (!c) return;

        const g = c.getContext("2d");
        if (!g) return;

        const dpr = c.width / Math.max(1, c.getBoundingClientRect().width);
        const rect = c.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);

        g.fillStyle = "rgba(241, 237, 230, 1)";
        g.fillRect(0, 0, w, h);

        const v = tapeSpeedRef.current;
        const intensity = Math.min(1, Math.abs(v) / MAX_V);

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

        const dir = v > DEADZONE ? 1 : v < -DEADZONE ? -1 : 0;
        if (dir !== 0 && lastDirRef.current !== 0 && dir !== lastDirRef.current) playClick();
        if (dir !== 0) lastDirRef.current = dir;

        // hiss behavior (more when forward)
        if (hissGainRef.current) {
            if (v > DEADZONE) hissGainRef.current.gain.setTargetAtTime(0.028, now, 0.05);
            else if (v < -DEADZONE) hissGainRef.current.gain.setTargetAtTime(0.016, now, 0.05);
            else hissGainRef.current.gain.setTargetAtTime(0.010, now, 0.08);
        }

        // rewind squeal
        if (squealGainRef.current) {
            if (v < -DEADZONE) {
                const amt = Math.min(0.20, (Math.abs(v) / MAX_V) * 0.20);
                squealGainRef.current.gain.setTargetAtTime(amt, now, 0.03);
            } else {
                squealGainRef.current.gain.setTargetAtTime(0.0, now, 0.04);
            }
        }

        if (Math.abs(v) <= DEADZONE) return;

        const speedNorm = Math.min(1, Math.abs(v) / MAX_V);
        const step = lerp(STEP_MAX, STEP_MIN, speedNorm);

        if (nextGrainTimeRef.current < now) nextGrainTimeRef.current = now;

        while (nextGrainTimeRef.current < now + LOOKAHEAD) {
            const forward = v > 0;
            const buf = forward ? bufF : bufR;

            let offset = forward
                ? playheadRef.current
                : Math.max(0, duration - playheadRef.current);

            offset = clamp(offset, 0, Math.max(0, buf.duration - GRAIN_SIZE));

            const src = ctx.createBufferSource();
            src.buffer = buf;

            // wow/flutter + tiny drift
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
       Main tick loop (throttled draws)
    ====================== */
    useEffect(() => {
        const tick = () => {
            if (readyRef.current && duration) {
                // smooth raw velocity
                tapeSpeedRef.current =
                    tapeSpeedRef.current * (1 - SPEED_SMOOTHING) +
                    velocityRef.current * SPEED_SMOOTHING;

                // move playhead
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

            const now = performance.now();

            // Photo canvas: 30fps mobile, 60fps desktop
            if (!IS_MOBILE || now - lastPhotoDrawRef.current > 33) {
                drawPhotos();
                lastPhotoDrawRef.current = now;
            }

            // Graph canvas: 30fps mobile, 60fps desktop
            if (!IS_MOBILE || now - lastGraphDrawRef.current > 33) {
                drawGraph();
                lastGraphDrawRef.current = now;
            }

            rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [duration, IS_MOBILE]);

    /* ======================
       Layout calculations
    ====================== */
    const prog = duration ? time / duration : 0;

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

                {/* ✅ Photos: pre-rendered strip -> viewport canvas */}
                <div className="mt-6 px-6">
                    <div className="rounded-md overflow-hidden" style={{ height: 128 }}>
                        <canvas
                            ref={photoCanvasRef}
                            className="w-full h-[128px] block"
                            style={{
                                // keep it crisp
                                imageRendering: "auto",
                            }}
                        />
                    </div>
                    {/* (Optional) keep CSS filter only for fallback DOM debugging; canvas already has filter baked-in */}
                    <div className="hidden" style={{ filter: photoFilterCSS }} />
                </div>

                {/* Window (audio graph) */}
                <div className="px-6 mt-6 relative">
                    <div className="h-14 rounded-md border border-[#e0dad0] bg-[#f1ede6] overflow-hidden">
                        <canvas ref={graphCanvasRef} className="w-full h-full" />
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
                    Counter-clockwise to play • Clockwise to rewind • Wind slowly for clearer audio
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

/* Soft tape-ish saturation curve */
function makeSoftSatCurve(amount = 0.55) {
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 2 + amount * 8;
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
}

/* Daisy SVG */
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

/* Noise source (looping) */
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

/* Reverse AudioBuffer */
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

/* Load image helper */
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        img.loading = "eager";
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

/* Draw image "cover" into rect (like object-cover) */
function drawCover(ctx, img, x, y, w, h) {
    const iw = img.width;
    const ih = img.height;
    if (!iw || !ih) return;

    const r = Math.max(w / iw, h / ih);
    const nw = iw * r;
    const nh = ih * r;

    const cx = x + (w - nw) / 2;
    const cy = y + (h - nh) / 2;

    // Rounded clip
    ctx.save();
    ctx.beginPath();
    roundedRectPath(ctx, x, y, w, h, 8);
    ctx.clip();
    ctx.drawImage(img, cx, cy, nw, nh);
    ctx.restore();
}

/* Rounded rect helpers */
function roundedRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    roundedRectPath(ctx, x, y, w, h, r);
}
