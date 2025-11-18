import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import type { LiveSession } from "@google/genai";
import { decode, decodeAudioData, createBlob } from './utils/audio';

enum AgentStatus {
  Idle = "Idle",
  Listening = "Listening...",
  Thinking = "Thinking...",
  Speaking = "Speaking...",
  Error = "Error",
}

// --- UI Icons ---
const MicrophoneIcon = ({ className }: { className?: string }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM11 5a1 1 0 0 1 2 0v6a1 1 0 0 1-2 0V5Z"></path>
        <path d="M12 15a5.006 5.006 0 0 0 5-5H15a3 3 0 0 1-3 3a3 3 0 0 1-3-3H7a5.006 5.006 0 0 0 5 5Z"></path>
        <path d="M19 11h-1.126a1 1 0 0 0 0 2H19a1 1 0 0 0 0-2Z M4 12a1 1 0 0 0 1 1h1.126a1 1 0 1 0 0-2H5a1 1 0 0 0-1 1Z"></path>
        <path d="M12 18a1 1 0 0 0 1-1v-1.133A6.983 6.983 0 0 0 19 9h1a1 1 0 0 0 0-2h-1a7.006 7.006 0 0 0-7-7a7.006 7.006 0 0 0-7 7H4a1 1 0 0 0 0 2h1a6.983 6.983 0 0 0 6 6.867V17a1 1 0 0 0 1 1Z"></path>
    </svg>
);

const StopIcon = ({ className }: { className?: string }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM9 9h6v6H9V9z"></path>
    </svg>
);

// --- Audio Waveform Component ---
const AudioWaveform = ({ analyserNode, isActive }: { analyserNode: AnalyserNode | null, isActive: boolean }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationFrameIdRef = useRef<number | null>(null);

    useEffect(() => {
        if (isActive && analyserNode && canvasRef.current) {
            const canvas = canvasRef.current;
            const canvasCtx = canvas.getContext('2d');
            const bufferLength = analyserNode.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            const draw = () => {
                if (!canvasCtx) return;

                animationFrameIdRef.current = requestAnimationFrame(draw);
                analyserNode.getByteFrequencyData(dataArray);

                canvasCtx.fillStyle = 'rgb(17 24 39)'; // bg-gray-900
                canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

                const barWidth = (canvas.width / bufferLength) * 2.5;
                let barHeight;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    barHeight = dataArray[i];
                    
                    const blue = barHeight + (25 * (i/bufferLength));
                    const green = 250 * (i/bufferLength);
                    const red = 50;
                    
                    canvasCtx.fillStyle = `rgb(${red}, ${green}, ${blue})`;
                    canvasCtx.fillRect(x, canvas.height - barHeight / 2, barWidth, barHeight / 2);

                    x += barWidth + 1;
                }
            };

            draw();

        } else {
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
            }
            const canvas = canvasRef.current;
            const canvasCtx = canvas?.getContext('2d');
            if (canvas && canvasCtx) {
                canvasCtx.fillStyle = 'rgb(17 24 39)'; // bg-gray-900
                canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
            }
        }

        return () => {
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
            }
        };
    }, [isActive, analyserNode]);

    return <canvas ref={canvasRef} className="w-full h-full" />;
};


export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>(AgentStatus.Idle);

  const sessionRef = useRef<LiveSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef(0);

  const systemInstruction = `You are an expert bilingual AI assistant, fluent in both English and Urdu. Your primary directive is to respond to the user in the language they primarily use.
1. If the user speaks in English, you must respond in English.
2. If the user speaks in Urdu, you must respond in Urdu using the standard Perso-Arabic script. Do not use the Roman alphabet for your Urdu responses.
3. If the user mixes English and Urdu, your response must be in Urdu, also using the Perso-Arabic script.
Always maintain a helpful and friendly conversational tone.`;


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
      analyser.fftSize = 256;
      analyser.connect(outputAudioContextRef.current.destination);
      analyserNodeRef.current = analyser;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
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
            if (message.serverContent?.inputTranscription) {
                if (message.serverContent.inputTranscription.isFinal) {
                    setAgentStatus(AgentStatus.Thinking);
                } else {
                    setAgentStatus(AgentStatus.Listening);
                }
            }

            if(message.serverContent?.turnComplete) {
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
            console.error('Session error:', e);
            setAgentStatus(AgentStatus.Error);
            stopConversation();
          },
          onclose: (e: CloseEvent) => {
            stopConversation();
          },
        },
      });

      sessionRef.current = await sessionPromise;

    } catch (error) {
      console.error("Failed to start conversation:", error);
      setAgentStatus(AgentStatus.Error);
      setIsSessionActive(false);
    }
  };

  const handleToggleSession = () => {
    if (isSessionActive) {
      stopConversation();
    } else {
      startConversation();
    }
  };

  const getStatusColor = () => {
    switch(agentStatus) {
        case AgentStatus.Listening: return 'text-green-400';
        case AgentStatus.Thinking: return 'text-yellow-400';
        case AgentStatus.Speaking: return 'text-blue-400';
        case AgentStatus.Error: return 'text-red-500';
        default: return 'text-gray-400';
    }
  }

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col font-sans">
      <header className="p-4 border-b border-gray-700">
        <h1 className="text-2xl font-bold text-center">Bilingual Voice AI Agent</h1>
        <p className="text-center text-gray-400 text-sm mt-1">Converses in English & Urdu</p>
      </header>

      <main className="flex-grow p-4 md:p-6 flex flex-col overflow-y-auto">
        {agentStatus !== AgentStatus.Speaking && (
          <div className="flex-grow flex items-center justify-center">
            <div className="text-center">
               <MicrophoneIcon className={`w-48 h-48 transition-colors duration-300 ${isSessionActive ? 'text-gray-600' : 'text-gray-700'}`} />
               {agentStatus === AgentStatus.Idle && <p className="text-gray-500 mt-4">Click the microphone to start</p>}
            </div>
          </div>
        )}
        <AudioWaveform
          analyserNode={analyserNodeRef.current}
          isActive={agentStatus === AgentStatus.Speaking}
        />
      </main>

      <footer className="p-4 border-t border-gray-700 bg-gray-900 sticky bottom-0">
        <div className="flex flex-col items-center justify-center gap-4">
          <p className={`text-lg font-medium transition-colors duration-300 ${getStatusColor()}`}>
            {agentStatus}
          </p>
          <button
            onClick={handleToggleSession}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-opacity-50 ${isSessionActive ? 'bg-red-600 hover:bg-red-700 focus:ring-red-400' : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-400'}`}
            aria-label={isSessionActive ? 'Stop conversation' : 'Start conversation'}
          >
            {isSessionActive ? <StopIcon className="w-10 h-10 text-white" /> : <MicrophoneIcon className="w-10 h-10 text-white" />}
          </button>
        </div>
      </footer>
    </div>
  );
}