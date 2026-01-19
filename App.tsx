import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { decode, decodeAudioData, createBlob } from './utils/audio';

enum AgentStatus {
  Idle = "Start",
  Listening = "Listening",
  Thinking = "Processing",
  Speaking = "Speaking",
  Error = "Error",
}

// --- Visualizer Component ---
const SonicOrb = ({ analyserNode, status }: { analyserNode: AnalyserNode | null, status: AgentStatus }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationFrameIdRef = useRef<number | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Function to handle resizing dynamically
        const setCanvasSize = () => {
            const dpr = window.devicePixelRatio || 1;
            // We use the parent container's dimensions
            const parent = canvas.parentElement;
            if (parent) {
                const rect = parent.getBoundingClientRect();
                canvas.width = rect.width * dpr;
                canvas.height = rect.height * dpr;
                ctx.scale(dpr, dpr);
            }
        };

        // Initial Set
        setCanvasSize();
        window.addEventListener('resize', setCanvasSize);

        let time = 0;
        
        const draw = () => {
            animationFrameIdRef.current = requestAnimationFrame(draw);
            
            // Re-fetch dimensions inside loop or rely on resize listener (listener is more efficient, 
            // but we need current width for drawing calculations)
            const width = canvas.width / (window.devicePixelRatio || 1);
            const height = canvas.height / (window.devicePixelRatio || 1);
            
            ctx.clearRect(0, 0, width, height);

            const bufferLength = analyserNode ? analyserNode.frequencyBinCount : 0;
            const dataArray = new Uint8Array(bufferLength);

            if (analyserNode && (status === AgentStatus.Speaking || status === AgentStatus.Listening)) {
                analyserNode.getByteFrequencyData(dataArray);
            }

            const centerX = width / 2;
            const centerY = height / 2;
            // Radius responsive to current canvas size
            const baseRadius = Math.min(width, height) / 4; 

            ctx.beginPath();
            
            for (let i = 0; i <= 100; i++) {
                const angle = (i / 100) * Math.PI * 2;
                
                let offset = 0;

                if (status === AgentStatus.Listening) {
                    offset = Math.sin(time * 0.05) * (baseRadius * 0.1); 
                } else if (status === AgentStatus.Speaking) {
                    const dataIndex = Math.floor((i / 100) * (bufferLength / 2));
                    const value = dataArray[dataIndex] || 0;
                    offset = (value / 255) * (baseRadius * 0.5);
                } else if (status === AgentStatus.Thinking) {
                     offset = Math.sin(time * 0.2) * (baseRadius * 0.15);
                }

                const noise = Math.sin(angle * 5 + time * 0.1) * (baseRadius * 0.05) + Math.cos(angle * 3 - time * 0.1) * (baseRadius * 0.05);
                
                const r = baseRadius + offset + noise;
                const x = centerX + Math.cos(angle) * r;
                const y = centerY + Math.sin(angle) * r;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }

            ctx.closePath();

            const gradient = ctx.createRadialGradient(centerX, centerY, baseRadius * 0.2, centerX, centerY, baseRadius * 2);
            if (status === AgentStatus.Error) {
                gradient.addColorStop(0, 'rgba(239, 68, 68, 0.8)');
                gradient.addColorStop(1, 'rgba(239, 68, 68, 0)');
            } else if (status === AgentStatus.Speaking) {
                gradient.addColorStop(0, 'rgba(124, 58, 237, 0.8)');
                gradient.addColorStop(0.5, 'rgba(245, 158, 11, 0.3)');
                gradient.addColorStop(1, 'rgba(124, 58, 237, 0)');
            } else {
                gradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
                gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
            }

            ctx.fillStyle = gradient;
            ctx.fill();

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;
            ctx.stroke();

            time += 1;
        };

        draw();

        return () => {
            window.removeEventListener('resize', setCanvasSize);
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
            }
        };
    }, [analyserNode, status]);

    return <canvas ref={canvasRef} className="w-full h-full block" />;
};

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>(AgentStatus.Idle);

  const sessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef(0);

  const systemInstruction = `You are a sophisticated bilingual voice AI. 
  Your core function is to fluently switch between Urdu and English based on the user's language.
  - If I speak English, reply in concise, witty English.
  - If I speak Urdu, reply in natural, conversational Urdu.
  - If I mix languages (Roman Urdu/English), reply in Urdu.
  - Keep responses short, human-like, and engaging. Avoid robotic pleasantries.`;

  const stopConversation = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
    }
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if (mediaStreamSourceRef.current) {
        mediaStreamSourceRef.current.disconnect();
        mediaStreamSourceRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
        outputAudioContextRef.current.close();
    }

    setIsSessionActive(false);
    setAgentStatus(AgentStatus.Idle);
    nextStartTimeRef.current = 0;
  }, []);

  useEffect(() => {
    return () => {
      stopConversation();
    };
  }, [stopConversation]);
  
  const startConversation = async () => {
    try {
      setAgentStatus(AgentStatus.Listening);
      setIsSessionActive(true);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      nextStartTimeRef.current = 0;
      
      const analyser = outputAudioContextRef.current.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      analyser.connect(outputAudioContextRef.current.destination);
      analyserNodeRef.current = analyser;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: systemInstruction,
        },
        callbacks: {
          onopen: () => {
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            mediaStreamSourceRef.current = source;
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription || message.serverContent?.turnComplete) {
                setAgentStatus(AgentStatus.Listening);
            }

            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current && analyserNodeRef.current) {
                setAgentStatus(AgentStatus.Speaking);
                const decodedAudio = decode(audioData);
                const audioBuffer = await decodeAudioData(decodedAudio, outputAudioContextRef.current, 24000, 1);
                
                const currentTime = outputAudioContextRef.current.currentTime;
                const startTime = Math.max(currentTime, nextStartTimeRef.current);

                const source = outputAudioContextRef.current.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(analyserNodeRef.current);
                source.start(startTime);

                nextStartTimeRef.current = startTime + audioBuffer.duration;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error(e);
            setAgentStatus(AgentStatus.Error);
            stopConversation();
          },
          onclose: () => {
            stopConversation();
          },
        },
      });

      sessionRef.current = await sessionPromise;

    } catch (error) {
      console.error(error);
      setAgentStatus(AgentStatus.Error);
      setIsSessionActive(false);
    }
  };

  const handleToggleSession = () => {
    if (isSessionActive) stopConversation();
    else startConversation();
  };

  return (
    // 100dvh (Dynamic Viewport Height) ensures full height on mobile browsers including address bars
    <div className="relative w-full min-h-[100dvh] flex flex-col items-center justify-between p-4 md:p-8 overflow-hidden bg-[#030305] text-gray-100 touch-none">
      
      {/* Background Ambience */}
      <div className="absolute top-[-20%] left-[-10%] w-[60vw] h-[60vw] bg-violet-900/20 rounded-full blur-[100px] md:blur-[128px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50vw] h-[50vw] bg-amber-900/20 rounded-full blur-[80px] md:blur-[100px] pointer-events-none" />

      {/* Header */}
      <header className="relative z-10 w-full flex justify-between items-center opacity-80 shrink-0">
        <div className="flex flex-col">
            <span className="text-[10px] md:text-xs uppercase tracking-widest text-gray-500">Bilingual Interface v2.0</span>
        </div>
        <div className="glass-panel px-3 py-1 rounded-full flex items-center gap-2 border border-white/5 bg-white/5 backdrop-blur-sm">
            <div className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full ${isSessionActive ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
            <span className="text-[10px] md:text-xs font-mono uppercase text-gray-400">{isSessionActive ? 'Online' : 'Offline'}</span>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 flex-grow flex flex-col items-center justify-center w-full">
        
        {/* The Sonic Orb Visualizer Container */}
        {/* 'vmin' sizes it relative to the smaller screen dimension (works for portrait & landscape) */}
        <div className="relative w-[70vmin] h-[70vmin] max-w-[500px] max-h-[500px] min-w-[250px] min-h-[250px] transition-all duration-300">
            <SonicOrb analyserNode={analyserNodeRef.current} status={agentStatus} />
            
            {/* Background Typography Depth Layer */}
            {/* Using fluid typography with clamp() */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full text-center pointer-events-none mix-blend-overlay opacity-30 flex items-center justify-center">
                <h1 
                    className="font-display font-bold tracking-tighter select-none blur-sm whitespace-nowrap transition-all duration-300"
                    style={{ fontSize: 'clamp(3rem, 18vmin, 8rem)' }}
                >
                    {agentStatus === AgentStatus.Speaking ? 'SUNIYE' : 'BOLIYE'}
                </h1>
            </div>
        </div>

        {/* Text Prompt / Subtitles */}
        <div className="mt-8 text-center h-8 md:h-12 shrink-0">
             <p className={`text-sm md:text-lg font-light tracking-wide transition-opacity duration-500 ${agentStatus !== AgentStatus.Idle ? 'opacity-100' : 'opacity-0'}`}>
                {agentStatus === AgentStatus.Listening && "Listening..."}
                {agentStatus === AgentStatus.Thinking && "Translating context..."}
                {agentStatus === AgentStatus.Speaking && "Responding..."}
                {agentStatus === AgentStatus.Error && <span className="text-red-400">Connection Error</span>}
            </p>
             {agentStatus === AgentStatus.Idle && (
                 <p className="text-xs md:text-base text-gray-500 font-light animate-pulse">Ready to converse in Urdu & English</p>
             )}
        </div>

      </main>

      {/* Footer Controls */}
      <footer className="relative z-10 w-full flex justify-center pb-4 md:pb-8 shrink-0">
        <button
            onClick={handleToggleSession}
            className={`group relative flex items-center justify-center px-6 py-3 md:px-8 md:py-4 rounded-full border bg-white/5 backdrop-blur-md transition-all duration-500 hover:bg-white/10 active:scale-95 ${isSessionActive ? 'border-red-500/30' : 'border-white/10'}`}
        >
            <span className={`absolute inset-0 rounded-full blur-md bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
            
            <div className="flex items-center gap-3 relative z-10">
                {isSessionActive ? (
                    <>
                        <span className="w-1.5 h-1.5 md:w-2 md:h-2 bg-red-500 rounded-sm animate-spin" />
                        <span className="font-mono text-xs md:text-sm uppercase tracking-widest text-red-200">Terminate</span>
                    </>
                ) : (
                    <>
                        <span className="w-1.5 h-1.5 md:w-2 md:h-2 bg-white rounded-full group-hover:bg-violet-400 transition-colors" />
                        <span className="font-mono text-xs md:text-sm uppercase tracking-widest">Initialize</span>
                    </>
                )}
            </div>
        </button>
      </footer>

    </div>
  );
                }
