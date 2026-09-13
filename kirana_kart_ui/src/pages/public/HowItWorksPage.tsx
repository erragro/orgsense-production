import { useEffect,useRef,useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
Mail,MessageSquare,FileText,Share2,Webhook,Mic,
ArrowRight,Sun,Moon,Zap,GitBranch,Shield,CheckCircle2,BarChart2,AlertTriangle,Activity,ChevronDown
} from 'lucide-react'
import { useUIStore } from '@/stores/ui.store'

// ─── Animations ──────────────────────────────────────────────────────────────

const ANIMATION_CSS = `
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(28px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes orb-drift {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33% { transform: translate(30px, -20px) scale(1.05); }
    66% { transform: translate(-20px, 15px) scale(0.97); }
  }
  @keyframes pulse-ring {
    0%   { transform: scale(0.95); opacity: 0.7; }
    70%  { transform: scale(1.35); opacity: 0; }
    100% { transform: scale(1.35); opacity: 0; }
  }
  @keyframes flow-dot {
    0%   { transform: translateY(0); opacity: 0; }
    20%  { opacity: 1; }
    80%  { opacity: 1; }
    100% { transform: translateY(72px); opacity: 0; }
  }
  @keyframes heartbeat-line {
    from { stroke-dashoffset: 700; }
    to   { stroke-dashoffset: 0; }
  }
  @keyframes bar-grow {
    from { width: 0%; }
    to   { width: var(--bar-w); }
  }
  @keyframes radiate {
    0%   { transform: scale(1); opacity: 0.6; }
    100% { transform: scale(2.2); opacity: 0; }
  }
  .orb-drift   { animation: orb-drift 18s ease-in-out infinite; }
  .orb-drift-2 { animation: orb-drift 22s ease-in-out infinite reverse 4s; }
  .hero-in-1   { animation: fade-up 0.7s ease forwards; }
  .hero-in-2   { animation: fade-up 0.7s ease forwards 0.15s; opacity: 0; }
  .hero-in-3   { animation: fade-up 0.7s ease forwards 0.3s; opacity: 0; }
  .reveal {
    opacity: 0;
    transform: translateY(24px);
    transition: opacity 0.55s ease, transform 0.55s ease;
  }
  .reveal.visible { opacity: 1; transform: translateY(0); }
  .flow-dot-1 { animation: flow-dot 1.6s ease-in-out infinite 0s; }
  .flow-dot-2 { animation: flow-dot 1.6s ease-in-out infinite 0.5s; }
  .flow-dot-3 { animation: flow-dot 1.6s ease-in-out infinite 1.0s; }
  .pulse-ring  { animation: pulse-ring 2s ease-out infinite; }
  .radiate-1   { animation: radiate 2.5s ease-out infinite 0s; }
  .radiate-2   { animation: radiate 2.5s ease-out infinite 0.8s; }
  .radiate-3   { animation: radiate 2.5s ease-out infinite 1.6s; }
`

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useReveal() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) el.classList.add('visible') },
      { threshold: 0.1 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return ref
}

function RevealSection({ children, className = '', delay = 0 }: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const ref = useReveal()
  return (
    <div ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

// ─── Navbar ───────────────────────────────────────────────────────────────────

function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const navigate = useNavigate()
  const { theme, toggleTheme } = useUIStore()

  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', h, { passive: true })
    return () => window.removeEventListener('scroll', h)
  }, [])

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled
        ? 'bg-white/90 dark:bg-zinc-950/90 backdrop-blur-md border-b border-slate-200/60 dark:border-zinc-800/60'
        : 'bg-transparent'
    }`}>
      <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
        <button onClick={() => navigate('/')} className="flex items-center gap-3 group">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-lg shadow-blue-600/30">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div className="text-left">
            <span className="text-slate-900 dark:text-white font-bold text-lg leading-none block">Auralis</span>
            <span className="text-slate-400 dark:text-zinc-500 text-xs leading-none block">orgsense.in</span>
          </div>
        </button>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/team')}
            className="text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white text-sm transition-colors px-3 py-2">
            Meet the Team
          </button>
          <button
            className="text-blue-600 dark:text-blue-400 font-medium text-sm px-3 py-2 cursor-default">
            How it Works
          </button>
          <button onClick={toggleTheme}
            className="p-2 rounded-lg border border-slate-200 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white transition-all"
            aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button onClick={() => navigate('/login')}
            className="text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white text-sm transition-colors px-4 py-2 rounded-lg border border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-500">
            Log In
          </button>
          <button onClick={() => navigate('/signup')}
            className="text-white text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 transition-all shadow-lg shadow-blue-600/20">
            Sign Up
          </button>
        </div>
      </div>
    </nav>
  )
}

// ─── Pipeline Stage Card ──────────────────────────────────────────────────────

const STAGES = [
  {
    num: '01',
    title: 'Intake',
    tagline: 'Cardinal receives the object — any format, any channel.',
    bullets: [
      'Accepts structured and unstructured inputs: emails, chat logs, forms, API payloads, voice summaries',
      'Normalises and deduplicates — identical complaints from different channels are recognised as one',
      'Enriches with context: customer history, prior cases, account signals',
    ],
    output: 'Normalised complaint object',
    accent: 'from-blue-600 to-blue-500',
    glow: 'blue',
    border: 'border-blue-500/30',
    bg: 'bg-blue-500/5',
  },
  {
    num: '02',
    title: 'Understand',
    tagline: 'Cardinal reads the situation and classifies the issue precisely.',
    bullets: [
      'Matches the complaint to the issue taxonomy — not just keywords, but meaning',
      'Assigns an issue type, sub-type, and confidence level',
      'Flags ambiguous cases for human review instead of guessing',
    ],
    output: 'Issue type · Sub-type · Confidence score',
    accent: 'from-violet-600 to-violet-500',
    glow: 'violet',
    border: 'border-violet-500/30',
    bg: 'bg-violet-500/5',
  },
  {
    num: '03',
    title: 'Decide',
    tagline: "Cardinal applies your policies to choose exactly the right action.",
    bullets: [
      'Looks up the active policy version for this issue type and business line',
      'Selects the action code: refund, replacement, escalation, acknowledgement, or custom',
      'Runs fraud and risk checks before committing to any resolution',
    ],
    output: 'Action code · Resolution amount · Risk classification',
    accent: 'from-emerald-600 to-teal-500',
    glow: 'emerald',
    border: 'border-emerald-500/30',
    bg: 'bg-emerald-500/5',
  },
  {
    num: '04',
    title: 'Act',
    tagline: 'Cardinal executes the decision — or hands off to the right specialist.',
    bullets: [
      'Dispatches the resolution automatically: email reply, ticket update, refund trigger, escalation',
      'Routes complex cases to the appropriate agent — never the wrong one',
      'Logs the full decision trail for QA and compliance',
    ],
    output: 'Resolved ticket · Audit log · Customer notification',
    accent: 'from-orange-600 to-amber-500',
    glow: 'orange',
    border: 'border-orange-500/30',
    bg: 'bg-orange-500/5',
  },
]

function StageCard({ stage, index }: { stage: typeof STAGES[0]; index: number }) {
  const [open, setOpen] = useState(false)
  const ref = useReveal()

  return (
    <div
      ref={ref}
      className="reveal relative"
      style={{ transitionDelay: `${index * 100}ms` }}
    >
      {/* Connector line + animated dots */}
      {index < STAGES.length - 1 && (
        <div className="absolute left-8 top-full w-0.5 h-8 bg-slate-200 dark:bg-zinc-800 z-10 flex flex-col items-center overflow-hidden">
          <div className={`w-1.5 h-1.5 rounded-full bg-blue-500 absolute top-0 ${
            index === 0 ? 'flow-dot-1' : index === 1 ? 'flow-dot-2' : 'flow-dot-3'
          }`} />
        </div>
      )}

      <button
        onClick={() => setOpen(!open)}
        className={`w-full text-left rounded-2xl border transition-all duration-300 overflow-hidden ${
          open
            ? `${stage.border} ${stage.bg} shadow-lg`
            : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 bg-white dark:bg-zinc-900/60'
        }`}
      >
        <div className="flex items-center gap-5 p-6">
          {/* Number badge */}
          <div className={`flex-shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br ${stage.accent} flex items-center justify-center shadow-lg`}>
            <span className="text-white font-bold text-lg">{stage.num}</span>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-slate-900 dark:text-white font-semibold text-lg">{stage.title}</span>
              {open && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full bg-gradient-to-r ${stage.accent} text-white`}>
                  Active
                </span>
              )}
            </div>
            <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{stage.tagline}</p>
          </div>

          <ChevronDown className={`w-5 h-5 text-slate-400 dark:text-zinc-500 flex-shrink-0 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
        </div>

        {/* Expandable detail */}
        <div className={`overflow-hidden transition-all duration-500 ease-in-out ${open ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-6 pb-6 border-t border-slate-100 dark:border-zinc-800 pt-5">
            <ul className="space-y-3 mb-5">
              {stage.bullets.map((b) => (
                <li key={b} className="flex items-start gap-3">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
                  <span className="text-slate-600 dark:text-zinc-300 text-sm leading-relaxed">{b}</span>
                </li>
              ))}
            </ul>
            <div className="inline-flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-zinc-800 px-3 py-2 text-xs text-slate-600 dark:text-zinc-300">
              <span className="font-semibold text-slate-400 dark:text-zinc-500">Output →</span>
              {stage.output}
            </div>
          </div>
        </div>
      </button>

      {index < STAGES.length - 1 && <div className="h-8" />}
    </div>
  )
}

// ─── Orchestration Diagram ────────────────────────────────────────────────────

const AGENTS = [
  { icon: Shield,     label: 'Fraud Detection',  angle: -60,  accent: 'from-rose-600 to-pink-500' },
  { icon: BookSearch, label: 'Policy Lookup',     angle: -20,  accent: 'from-violet-600 to-violet-500' },
  { icon: CheckCircle2,label: 'Resolution',       angle: 20,   accent: 'from-emerald-600 to-teal-500' },
  { icon: AlertTriangle,label: 'Escalation',      angle: 60,   accent: 'from-orange-600 to-amber-500' },
]

function BookSearch({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.966 8.966 0 00-6 2.292m0-14.25v14.25" />
      <circle cx="17" cy="16" r="3" />
      <path strokeLinecap="round" d="M19.5 18.5l1.5 1.5" />
    </svg>
  )
}

function OrchestrationDiagram() {
  const RADIUS = 160

  return (
    <div className="relative flex items-center justify-center" style={{ height: 420 }}>
      {/* Center Cardinal node */}
      <div className="relative z-10 flex flex-col items-center">
        {/* Radiating rings */}
        <div className="absolute w-28 h-28 rounded-full bg-blue-500/20 radiate-1" />
        <div className="absolute w-28 h-28 rounded-full bg-blue-500/15 radiate-2" />
        <div className="absolute w-28 h-28 rounded-full bg-blue-500/10 radiate-3" />

        <div className="relative w-28 h-28 rounded-full bg-gradient-to-br from-blue-600 to-violet-600 flex flex-col items-center justify-center shadow-2xl shadow-blue-600/40">
          <Zap className="w-10 h-10 text-white mb-1" />
          <span className="text-white font-bold text-sm">Cardinal</span>
        </div>
      </div>

      {/* Agent nodes + connector lines */}
      {AGENTS.map((agent, i) => {

        // Fan layout: left side for first two, right for last two
        const side = i < 2 ? -1 : 1
        const yOff = i % 2 === 0 ? -80 : 80
        const xOff = side * RADIUS

        return (
          <div
            key={agent.label}
            className="absolute flex flex-col items-center gap-2"
            style={{ transform: `translate(${xOff}px, ${yOff}px)` }}
          >
            {/* Connector line - simplified SVG */}
            <svg
              className="absolute pointer-events-none"
              style={{
                width: Math.abs(xOff) + 60,
                height: Math.abs(yOff) + 40,
                top: yOff < 0 ? 'auto' : `-${Math.abs(yOff) + 20}px`,
                bottom: yOff < 0 ? `-${Math.abs(yOff) + 20}px` : 'auto',
                left: side < 0 ? 'auto' : `-${Math.abs(xOff) + 30}px`,
                right: side < 0 ? `-${Math.abs(xOff) + 30}px` : 'auto',
                opacity: 0.3,
              }}
            >
            </svg>

            <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${agent.accent} flex items-center justify-center shadow-lg`}>
              <agent.icon className="w-6 h-6 text-white" />
            </div>
            <span className="text-xs text-slate-500 dark:text-zinc-400 font-medium text-center whitespace-nowrap">
              {agent.label}
            </span>
          </div>
        )
      })}

      {/* SVG lines connecting center to agents */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.25 }}>
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" className="fill-blue-500" />
          </marker>
        </defs>
        {/* Left top */}
        <line x1="50%" y1="50%" x2="calc(50% - 160px)" y2="calc(50% - 80px)" stroke="currentColor" className="text-blue-500" strokeWidth="1.5" strokeDasharray="4 3" markerEnd="url(#arrow)" />
        {/* Left bottom */}
        <line x1="50%" y1="50%" x2="calc(50% - 160px)" y2="calc(50% + 80px)" stroke="currentColor" className="text-violet-500" strokeWidth="1.5" strokeDasharray="4 3" markerEnd="url(#arrow)" />
        {/* Right top */}
        <line x1="50%" y1="50%" x2="calc(50% + 160px)" y2="calc(50% - 80px)" stroke="currentColor" className="text-emerald-500" strokeWidth="1.5" strokeDasharray="4 3" markerEnd="url(#arrow)" />
        {/* Right bottom */}
        <line x1="50%" y1="50%" x2="calc(50% + 160px)" y2="calc(50% + 80px)" stroke="currentColor" className="text-orange-500" strokeWidth="1.5" strokeDasharray="4 3" markerEnd="url(#arrow)" />
      </svg>
    </div>
  )
}

// ─── Workload Toggle ──────────────────────────────────────────────────────────

const WITHOUT_DATA = [
  { label: 'Agent A', pct: 94, overflow: true },
  { label: 'Agent B', pct: 18, overflow: false },
  { label: 'Agent C', pct: 71, overflow: false },
  { label: 'Agent D', pct: 42, overflow: false },
  { label: 'Agent E', pct: 88, overflow: true },
]
const WITH_DATA = [
  { label: 'Agent A', pct: 58, overflow: false },
  { label: 'Agent B', pct: 55, overflow: false },
  { label: 'Agent C', pct: 62, overflow: false },
  { label: 'Agent D', pct: 57, overflow: false },
  { label: 'Agent E', pct: 60, overflow: false },
]

function WorkloadToggle() {
  const [withAuralis, setWithAuralis] = useState(false)
  const data = withAuralis ? WITH_DATA : WITHOUT_DATA

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-8">
      {/* Toggle */}
      <div className="flex items-center justify-center mb-8">
        <div className="inline-flex rounded-xl border border-slate-200 dark:border-zinc-800 overflow-hidden">
          <button
            onClick={() => setWithAuralis(false)}
            className={`px-5 py-2.5 text-sm font-medium transition-all ${
              !withAuralis
                ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
            }`}
          >
            Without Auralis
          </button>
          <button
            onClick={() => setWithAuralis(true)}
            className={`px-5 py-2.5 text-sm font-medium transition-all ${
              withAuralis
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
            }`}
          >
            With Auralis
          </button>
        </div>
      </div>

      {/* Bars */}
      <div className="space-y-4">
        {data.map((d) => (
          <div key={d.label} className="flex items-center gap-4">
            <span className="text-slate-500 dark:text-zinc-400 text-sm w-14 flex-shrink-0">{d.label}</span>
            <div className="flex-1 h-7 bg-slate-100 dark:bg-zinc-800 rounded-lg overflow-hidden">
              <div
                className={`h-full rounded-lg transition-all duration-700 ease-out flex items-center justify-end pr-2 ${
                  d.overflow
                    ? 'bg-gradient-to-r from-red-500 to-rose-500'
                    : withAuralis
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
                    : 'bg-gradient-to-r from-blue-500 to-violet-500'
                }`}
                style={{ width: `${d.pct}%` }}
              >
                {d.pct > 30 && (
                  <span className="text-white text-xs font-medium">{d.pct}%</span>
                )}
              </div>
            </div>
            {d.overflow && (
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
            )}
            {!d.overflow && withAuralis && (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            )}
          </div>
        ))}
      </div>

      <p className={`text-center text-sm mt-6 transition-all duration-500 ${
        withAuralis ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
      }`}>
        {withAuralis
          ? 'Cardinal distributes workload evenly across your team — no agent drowns, no case falls through.'
          : 'Without routing intelligence, high-volume agents burn out while others sit idle.'}
      </p>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const OBJECT_TYPES = [
  { icon: Mail,         label: 'Email Complaints',     sub: 'Any inbox, any format' },
  { icon: MessageSquare,label: 'Live Chat',             sub: 'Full transcript context' },
  { icon: FileText,     label: 'Support Forms',         sub: 'Structured or free-text' },
  { icon: Share2,       label: 'Social Media DMs',      sub: 'Twitter, Instagram, more' },
  { icon: Webhook,      label: 'API Webhooks',          sub: 'Programmatic integrations' },
  { icon: Mic,          label: 'Voice Summaries',       sub: 'Post-call transcripts' },
]

export default function HowItWorksPage() {
  const navigate = useNavigate()
  const { theme } = useUIStore()

  const dotGrid = theme === 'dark'
    ? 'radial-gradient(circle, rgba(255,255,255,0.055) 1px, transparent 1px)'
    : 'radial-gradient(circle, rgba(0,0,0,0.055) 1px, transparent 1px)'

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-slate-900 dark:text-white overflow-x-hidden">
      <style>{ANIMATION_CSS}</style>
      <Navbar />

      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <section className="relative pt-36 pb-24 px-6 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: dotGrid, backgroundSize: '28px 28px' }} />
        <div className="orb-drift absolute -top-32 left-1/4 w-[600px] h-[500px] rounded-full bg-blue-600/10 dark:bg-blue-600/12 blur-[120px] pointer-events-none" />
        <div className="orb-drift-2 absolute top-20 right-1/4 w-[400px] h-[400px] rounded-full bg-violet-600/8 dark:bg-violet-600/10 blur-[100px] pointer-events-none" />

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="hero-in-1 inline-flex items-center gap-2 rounded-full border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 px-4 py-1.5 text-xs text-blue-600 dark:text-blue-400 font-medium mb-8">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            Multi-agent · Any channel · Workload-aware
          </div>

          <h1 className="hero-in-2 text-5xl md:text-6xl font-bold leading-[1.06] tracking-tight mb-6">
            <span className="text-slate-900 dark:text-white">Cardinal: The Intelligence</span>
            <br />
            <span className="bg-gradient-to-r from-blue-500 via-violet-500 to-blue-400 bg-clip-text text-transparent">
              That Never Sleeps
            </span>
          </h1>

          <p className="hero-in-3 text-slate-500 dark:text-zinc-400 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            From any complaint — email, chat, form, or API — to a consistent, audited decision in seconds.
            Your entire CX operation, automated.
          </p>

          {/* Animated heartbeat bar */}
          <div className="mt-12 mx-auto max-w-md">
            <svg viewBox="0 0 400 64" className="w-full" style={{ height: 64 }}>
              <defs>
                <linearGradient id="hbGrad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity="0" />
                  <stop offset="35%" stopColor="#3b82f6" />
                  <stop offset="65%" stopColor="#8b5cf6" />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* Faint static trace */}
              <path
                d="M0,32 L72,32 C75,32 77,30 80,24 C83,18 85,8 88,4 C91,0 93,50 96,56 C98,60 101,46 104,38 C106,34 108,32 112,32 L188,32 C191,32 193,30 196,24 C199,18 201,8 204,4 C207,0 209,50 212,56 C214,60 217,46 220,38 C222,34 224,32 228,32 L400,32"
                fill="none"
                stroke="url(#hbGrad)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.18}
              />
              {/* Traveling highlight segment */}
              <path
                d="M0,32 L72,32 C75,32 77,30 80,24 C83,18 85,8 88,4 C91,0 93,50 96,56 C98,60 101,46 104,38 C106,34 108,32 112,32 L188,32 C191,32 193,30 196,24 C199,18 201,8 204,4 C207,0 209,50 212,56 C214,60 217,46 220,38 C222,34 224,32 228,32 L400,32"
                fill="none"
                stroke="url(#hbGrad)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="140 560"
                style={{ animation: 'heartbeat-line 3s linear infinite' }}
              />
            </svg>
            <p className="text-xs text-slate-400 dark:text-zinc-500 text-center mt-2">Live ticket stream</p>
          </div>
        </div>
      </section>

      {/* ── What Cardinal handles ────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-14">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 font-medium mb-4">
              Any Object, Any Channel
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              Not just email. <span className="bg-gradient-to-r from-blue-500 to-violet-500 bg-clip-text text-transparent">Anything.</span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Cardinal treats every input the same — regardless of where it came from or what format it's in.
            </p>
          </RevealSection>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {OBJECT_TYPES.map((obj, i) => (
              <RevealSection key={obj.label} delay={i * 70}>
                <div className="group rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-5 hover:border-blue-300/60 dark:hover:border-zinc-600 hover:shadow-xl hover:shadow-blue-500/5 transition-all duration-300 cursor-default">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600/10 to-violet-600/10 dark:from-blue-600/20 dark:to-violet-600/20 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300">
                    <obj.icon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-slate-900 dark:text-white font-semibold text-sm mb-1">{obj.label}</p>
                  <p className="text-slate-400 dark:text-zinc-500 text-xs">{obj.sub}</p>
                  <div className="mt-3 text-xs text-blue-500 dark:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center gap-1">
                    Cardinal processes this identically <ArrowRight className="w-3 h-3" />
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── 4-Stage Pipeline ─────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-blue-600/3 dark:bg-blue-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-6xl relative">
          <RevealSection className="text-center mb-16">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 px-4 py-1.5 text-xs text-blue-600 dark:text-blue-400 font-medium mb-4">
              The Pipeline
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              Four stages. One seamless flow.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Click any stage to see exactly what happens inside. No black boxes.
            </p>
          </RevealSection>

          <div className="grid md:grid-cols-2 gap-12 items-start">
            {/* Stage cards */}
            <div>
              {STAGES.map((s, i) => (
                <StageCard key={s.num} stage={s} index={i} />
              ))}
            </div>

            {/* Sticky explainer */}
            <div className="hidden md:block">
              <RevealSection delay={200}>
                <div className="sticky top-28 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-8 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center mx-auto mb-6 shadow-xl shadow-blue-600/30">
                    <Activity className="w-8 h-8 text-white" />
                  </div>
                  <h3 className="text-slate-900 dark:text-white font-bold text-xl mb-3">
                    Every stage is deterministic
                  </h3>
                  <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed mb-6">
                    Cardinal doesn't guess. At each stage, the output is defined by your policies and your taxonomy — the same input always produces the same result.
                  </p>
                  <div className="space-y-3 text-left">
                    {[
                      'No inconsistency between agents',
                      'Full audit trail at every step',
                      'Configurable for your business rules',
                    ].map((t) => (
                      <div key={t} className="flex items-center gap-2.5 text-sm text-slate-600 dark:text-zinc-300">
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                        {t}
                      </div>
                    ))}
                  </div>
                </div>
              </RevealSection>
            </div>
          </div>
        </div>
      </section>

      {/* ── Multi-agent Orchestration ────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-200 dark:border-violet-900/60 bg-violet-50 dark:bg-violet-950/30 px-4 py-1.5 text-xs text-violet-600 dark:text-violet-400 font-medium mb-4">
              Multi-Agent Orchestration
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              Cardinal doesn't just decide — it <span className="bg-gradient-to-r from-violet-500 to-blue-500 bg-clip-text text-transparent">conducts.</span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Complex situations need more than one answer. Cardinal coordinates specialist agents in parallel, then merges the results into a single coherent decision.
            </p>
          </RevealSection>

          <RevealSection delay={150}>
            <OrchestrationDiagram />
          </RevealSection>

          <div className="grid sm:grid-cols-3 gap-5 mt-10">
            {[
              { icon: GitBranch, title: 'Parallel processing', desc: 'All specialist agents run simultaneously — no sequential waiting.', accent: 'text-violet-500' },
              { icon: BarChart2, title: 'Complexity-based routing', desc: "Simple cases resolve instantly. Complex ones get the full specialist treatment.", accent: 'text-blue-500' },
              { icon: CheckCircle2, title: 'Full audit trail', desc: 'Every agent call, every decision, every output — logged and attributable.', accent: 'text-emerald-500' },
            ].map((item) => (
              <RevealSection key={item.title}>
                <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-6 text-center">
                  <item.icon className={`w-7 h-7 mx-auto mb-3 ${item.accent}`} />
                  <h4 className="text-slate-900 dark:text-white font-semibold mb-2">{item.title}</h4>
                  <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{item.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── Workload Distribution ────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-emerald-600/3 dark:bg-emerald-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-4xl relative">
          <RevealSection className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium mb-4">
              Workload Distribution
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              Intelligent load balancing.
              <br />
              <span className="bg-gradient-to-r from-emerald-500 to-teal-500 bg-clip-text text-transparent">No agent overload.</span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Cardinal continuously rebalances the queue so no one team member drowns while another sits idle.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <WorkloadToggle />
          </RevealSection>
        </div>
      </section>

      {/* ── What you get ─────────────────────────────────────────────────────── */}
      <section className="py-20 px-6 border-t border-slate-100 dark:border-zinc-900 bg-slate-950 dark:bg-zinc-900/40">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-slate-800 dark:bg-zinc-700 rounded-2xl overflow-hidden">
            {[
              { value: 'Any source', sub: 'Email, chat, form, webhook, voice — Cardinal normalises every input the same way', accent: 'text-blue-400' },
              { value: 'Policy-exact', sub: 'Decisions are derived from your configured rules — the same input always produces the same output', accent: 'text-violet-400' },
              { value: 'Full audit', sub: 'Every stage of every decision is logged. Nothing is inferred, sampled, or left unrecorded', accent: 'text-emerald-400' },
            ].map((item) => (
              <div key={item.value} className="bg-slate-950 dark:bg-zinc-950 px-8 py-10 text-center">
                <div className={`text-3xl md:text-4xl font-bold mb-3 ${item.accent}`}>{item.value}</div>
                <div className="text-slate-400 text-sm leading-relaxed">{item.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Control section ──────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-14">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 font-medium mb-4">
              Your rules. Your brand. Your speed.
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              Automate everything.
              <br />
              <span className="bg-gradient-to-r from-blue-500 to-violet-500 bg-clip-text text-transparent">Control what matters.</span>
            </h2>
          </RevealSection>

          <div className="grid sm:grid-cols-3 gap-6">
            {[
              {
                emoji: '🗂',
                title: 'Policy-driven',
                desc: 'Cardinal executes your SOPs exactly as defined — every ticket, every time, with no drift between decisions.',
                accent: 'border-blue-200 dark:border-blue-900/40',
              },
              {
                emoji: '🔒',
                title: 'Fully configurable',
                desc: 'Set your own thresholds, escalation paths, refund limits, and fraud flags. Cardinal follows, never overrides.',
                accent: 'border-violet-200 dark:border-violet-900/40',
              },
              {
                emoji: '📈',
                title: 'Scales with your team',
                desc: 'As your operation grows, Cardinal absorbs the volume. Your team focuses on the exceptions that need human judgment.',
                accent: 'border-emerald-200 dark:border-emerald-900/40',
              },
            ].map((item, i) => (
              <RevealSection key={item.title} delay={i * 100}>
                <div className={`h-full rounded-2xl border ${item.accent} bg-white dark:bg-zinc-900/60 p-8 hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/30 transition-all duration-300`}>
                  <div className="text-3xl mb-4">{item.emoji}</div>
                  <h3 className="text-slate-900 dark:text-white font-semibold text-lg mb-3">{item.title}</h3>
                  <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{item.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer CTA ───────────────────────────────────────────────────────── */}
      <section className="py-28 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-blue-600/5 dark:bg-blue-600/8 blur-[100px]" />
        </div>
        <RevealSection className="mx-auto max-w-3xl text-center relative">
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
            Ready to put Cardinal to work?
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-10">
            Set up in minutes. Your first automated decisions will ship the same day.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button onClick={() => navigate('/signup')}
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-semibold text-sm transition-all shadow-xl shadow-blue-600/25 hover:shadow-blue-600/40 hover:-translate-y-0.5">
              Get Started Free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <button onClick={() => navigate('/')}
              className="px-10 py-4 rounded-xl border border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-500 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white font-medium text-sm transition-all hover:-translate-y-0.5">
              Back to Home
            </button>
          </div>
        </RevealSection>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 dark:border-zinc-900 py-8 px-6">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-400 dark:text-zinc-500 text-sm">
            <div className="flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-blue-600 to-violet-600">
              <Zap className="w-3 h-3 text-white" />
            </div>
            Auralis · orgsense.in
          </div>
          <div className="text-slate-300 dark:text-zinc-600 text-sm">© 2026 Auralis. All rights reserved.</div>
        </div>
      </footer>
    </div>
  )
}
