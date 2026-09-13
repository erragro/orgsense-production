import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight, Sun, Moon, Zap, ShieldCheck, Copy, GitMerge,
  AlertTriangle, CheckCircle2, XCircle, ChevronRight, Filter,
  ArrowDownUp, FileWarning, Layers,
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
  @keyframes slide-right {
    from { transform: translateX(-100%); opacity: 0; }
    to   { transform: translateX(0); opacity: 1; }
  }
  @keyframes ticket-in {
    0%   { opacity: 0; transform: translateY(-20px); }
    15%  { opacity: 1; transform: translateY(0); }
    80%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(20px); }
  }
  @keyframes badge-pop {
    0%   { transform: scale(0.8); opacity: 0; }
    60%  { transform: scale(1.1); }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes pulse-slow {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .orb-drift   { animation: orb-drift 18s ease-in-out infinite; }
  .orb-drift-2 { animation: orb-drift 22s ease-in-out infinite reverse 4s; }
  .hero-in-1 { animation: fade-up 0.7s ease forwards; }
  .hero-in-2 { animation: fade-up 0.7s ease forwards 0.15s; opacity: 0; }
  .hero-in-3 { animation: fade-up 0.7s ease forwards 0.3s; opacity: 0; }
  .reveal {
    opacity: 0;
    transform: translateY(24px);
    transition: opacity 0.55s ease, transform 0.55s ease;
  }
  .reveal.visible { opacity: 1; transform: translateY(0); }
  .badge-pop { animation: badge-pop 0.4s ease forwards; }
  .pulse-slow { animation: pulse-slow 2s ease-in-out infinite; }
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
        <button onClick={() => navigate('/')} className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-lg shadow-blue-600/30">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div className="text-left">
            <span className="text-slate-900 dark:text-white font-bold text-lg leading-none block">Auralis</span>
            <span className="text-slate-400 dark:text-zinc-500 text-xs leading-none block">orgsense.in</span>
          </div>
        </button>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/how-it-works')}
            className="text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white text-sm transition-colors px-3 py-2">
            How it Works
          </button>
          <button onClick={() => navigate('/team')}
            className="text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white text-sm transition-colors px-3 py-2">
            Meet the Team
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
            className="text-white text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 transition-all shadow-lg shadow-violet-600/20">
            Sign Up
          </button>
        </div>
      </div>
    </nav>
  )
}

// ─── Interactive: What L2 Catches ────────────────────────────────────────────

type TicketState = 'pending' | 'duplicate' | 'conflict' | 'invalid' | 'clean'

interface Ticket {
  id: string
  text: string
  channel: string
  state: TicketState
  label?: string
}

const TICKET_POOL: Ticket[] = [
  { id: 'T-001', text: 'My order never arrived after 5 days', channel: 'Email', state: 'clean' },
  { id: 'T-002', text: 'My order never arrived after 5 days', channel: 'Chat', state: 'duplicate', label: 'Duplicate of T-001' },
  { id: 'T-003', text: 'Refund request for damaged product', channel: 'Form', state: 'clean' },
  { id: 'T-004', text: 'Charged twice for same order', channel: 'Email', state: 'conflict', label: 'Two policies match — needs resolution' },
  { id: 'T-005', text: 'Wrong item delivered', channel: 'Chat', state: 'clean' },
  { id: 'T-006', text: '...', channel: 'API', state: 'invalid', label: 'Empty description — cannot classify' },
  { id: 'T-007', text: 'Product quality not as described', channel: 'Email', state: 'clean' },
  { id: 'T-008', text: 'My order never arrived', channel: 'Twitter DM', state: 'duplicate', label: 'Duplicate of T-001 via different channel' },
]

function CatchDemo() {
  const [active, setActive] = useState<TicketState | 'all'>('all')

  const stateConfig: Record<TicketState, { label: string; color: string; icon: React.ElementType; bg: string; border: string }> = {
    clean:     { label: 'Passes through',      color: 'text-emerald-600 dark:text-emerald-400', icon: CheckCircle2, bg: 'bg-emerald-500/8 dark:bg-emerald-500/10', border: 'border-emerald-200 dark:border-emerald-800/50' },
    duplicate: { label: 'Duplicate caught',     color: 'text-amber-600 dark:text-amber-400',    icon: Copy,         bg: 'bg-amber-500/8 dark:bg-amber-500/10',   border: 'border-amber-200 dark:border-amber-800/50'   },
    conflict:  { label: 'Rule conflict flagged', color: 'text-rose-600 dark:text-rose-400',     icon: GitMerge,     bg: 'bg-rose-500/8 dark:bg-rose-500/10',     border: 'border-rose-200 dark:border-rose-800/50'     },
    invalid:   { label: 'Invalid — rejected',   color: 'text-slate-500 dark:text-zinc-400',    icon: XCircle,      bg: 'bg-slate-100 dark:bg-zinc-800/50',      border: 'border-slate-200 dark:border-zinc-700'       },
    pending:   { label: 'Pending',               color: 'text-slate-400',                       icon: Filter,       bg: 'bg-slate-50 dark:bg-zinc-900',          border: 'border-slate-200 dark:border-zinc-800'       },
  }

  const filtered = active === 'all' ? TICKET_POOL : TICKET_POOL.filter((t) => t.state === active)

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2 p-4 border-b border-slate-100 dark:border-zinc-800 bg-slate-50/60 dark:bg-zinc-900/40">
        <button
          onClick={() => setActive('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            active === 'all'
              ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          All ({TICKET_POOL.length})
        </button>
        {(['clean', 'duplicate', 'conflict', 'invalid'] as TicketState[]).map((s) => {
          const cfg = stateConfig[s]
          const count = TICKET_POOL.filter((t) => t.state === s).length
          return (
            <button
              key={s}
              onClick={() => setActive(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                active === s
                  ? `${cfg.bg} ${cfg.color} border ${cfg.border}`
                  : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
              }`}
            >
              {cfg.label} ({count})
            </button>
          )
        })}
      </div>

      {/* Ticket list */}
      <div className="divide-y divide-slate-100 dark:divide-zinc-800">
        {filtered.map((ticket) => {
          const cfg = stateConfig[ticket.state]
          const Icon = cfg.icon
          return (
            <div key={ticket.id} className={`flex items-start gap-4 p-4 ${ticket.state !== 'clean' ? cfg.bg : ''} transition-colors`}>
              <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${cfg.color}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className="text-slate-900 dark:text-white text-sm font-medium">{ticket.text}</span>
                  <span className="text-slate-400 dark:text-zinc-500 text-xs">· {ticket.channel}</span>
                  <span className="text-slate-400 dark:text-zinc-600 text-xs">{ticket.id}</span>
                </div>
                {ticket.label && (
                  <div className={`text-xs font-medium ${cfg.color}`}>{ticket.label}</div>
                )}
              </div>
              <div className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.border} ${cfg.color}`}>
                {cfg.label}
              </div>
            </div>
          )
        })}
      </div>

      <div className="px-4 py-3 bg-slate-50/60 dark:bg-zinc-900/40 border-t border-slate-100 dark:border-zinc-800 text-xs text-slate-400 dark:text-zinc-500">
        L2 screens every incoming ticket before it reaches Cardinal or any agent.
      </div>
    </div>
  )
}

// ─── Interactive: Pipeline position ──────────────────────────────────────────

function PipelinePosition() {
  const [hoveredStep, setHoveredStep] = useState<number | null>(null)

  const steps = [
    { label: 'Ticket arrives', sub: 'Any channel', icon: ArrowDownUp, color: 'from-slate-500 to-slate-400', active: false },
    { label: 'L2 Validator', sub: 'Screens, deduplicates, validates', icon: ShieldCheck, color: 'from-violet-600 to-violet-500', active: true },
    { label: 'Cardinal', sub: 'Classifies & decides', icon: Zap, color: 'from-blue-600 to-blue-500', active: false },
    { label: 'Resolution', sub: 'Action dispatched', icon: CheckCircle2, color: 'from-emerald-600 to-emerald-500', active: false },
  ]

  const tooltips: Record<number, string> = {
    0: "A complaint comes in — email, chat, form, API. It's raw and unverified at this point.",
    1: "L2 runs before anything else. It catches duplicates, flags conflicts, and rejects malformed inputs so Cardinal only sees clean, actionable cases.",
    2: "Cardinal receives only valid, unique, policy-ready tickets. It can classify and decide without wasting cycles on noise.",
    3: "The right action is taken — refund triggered, escalation routed, or acknowledgement sent — based on a clean decision trail.",
  }

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-8">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-0">
        {steps.map((step, i) => (
          <div key={step.label} className="flex sm:flex-col items-center sm:flex-1 gap-3 sm:gap-0">
            {/* Node */}
            <button
              onMouseEnter={() => setHoveredStep(i)}
              onMouseLeave={() => setHoveredStep(null)}
              onClick={() => setHoveredStep(hoveredStep === i ? null : i)}
              className={`relative flex-shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br ${step.color} flex items-center justify-center shadow-lg transition-all duration-300 ${
                step.active
                  ? 'scale-110 ring-4 ring-violet-500/30 shadow-violet-500/30'
                  : 'hover:scale-105'
              }`}
            >
              <step.icon className="w-6 h-6 text-white" />
              {step.active && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-violet-400 rounded-full border-2 border-white dark:border-zinc-900 pulse-slow" />
              )}
            </button>

            {/* Label */}
            <div className="sm:text-center mt-0 sm:mt-3">
              <div className={`text-sm font-semibold ${step.active ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-zinc-200'}`}>
                {step.label}
              </div>
              <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{step.sub}</div>
            </div>

            {/* Connector */}
            {i < steps.length - 1 && (
              <div className="hidden sm:flex flex-shrink-0 items-center mx-1">
                <div className="w-12 h-0.5 bg-slate-200 dark:bg-zinc-700 relative">
                  <ChevronRight className="w-4 h-4 text-slate-300 dark:text-zinc-600 absolute -right-2 -top-2" />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Tooltip area */}
      {hoveredStep !== null && (
        <div className={`mt-6 p-4 rounded-xl border transition-all ${
          hoveredStep === 1
            ? 'bg-violet-50 dark:bg-violet-950/30 border-violet-200 dark:border-violet-800/50 text-violet-700 dark:text-violet-300'
            : 'bg-slate-50 dark:bg-zinc-800/60 border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300'
        } text-sm leading-relaxed`}>
          {tooltips[hoveredStep]}
        </div>
      )}
      {hoveredStep === null && (
        <p className="mt-6 text-xs text-slate-400 dark:text-zinc-500 text-center">
          Hover or tap any step to learn what happens there.
        </p>
      )}
    </div>
  )
}

// ─── Check types ─────────────────────────────────────────────────────────────

const CHECKS = [
  {
    icon: Copy,
    title: 'Duplicate Detection',
    tagline: 'Same complaint, different channel — caught before it creates two cases.',
    how: 'When a customer emails and also sends a chat about the exact same issue, L2 recognises them as one complaint. The cases are merged. Your team works it once.',
    why: 'Without this, the same problem gets resolved twice — wasting agent time, confusing the customer, and polluting your reporting.',
    accent: 'from-amber-600 to-amber-500',
    border: 'border-amber-200 dark:border-amber-900/50',
    bg: 'bg-amber-50 dark:bg-amber-950/20',
    textAccent: 'text-amber-600 dark:text-amber-400',
  },
  {
    icon: GitMerge,
    title: 'Rule Conflict Detection',
    tagline: 'Two policies claiming the same issue — flagged before Cardinal tries to apply both.',
    how: 'If your policy configuration has two rules that both match the same issue type, L2 catches the ambiguity and raises a flag before the ticket enters the decision pipeline.',
    why: 'A conflict between policies means Cardinal has no clear instruction. L2 stops the ticket, surfaces the conflict to your ops team, and prevents an incorrect or arbitrary resolution.',
    accent: 'from-rose-600 to-rose-500',
    border: 'border-rose-200 dark:border-rose-900/50',
    bg: 'bg-rose-50 dark:bg-rose-950/20',
    textAccent: 'text-rose-600 dark:text-rose-400',
  },
  {
    icon: FileWarning,
    title: 'Schema Validation',
    tagline: 'Incomplete or malformed tickets rejected at the gate — not mid-pipeline.',
    how: 'A ticket needs a description, a channel, and identifiable context. If it arrives empty, truncated, or structurally broken, L2 rejects it with a clear reason code before it wastes any pipeline resources.',
    why: 'Malformed tickets that slip through can cause silent failures deep in the pipeline — misclassification, null resolutions, or corrupt audit logs. L2 stops that at the entry point.',
    accent: 'from-slate-600 to-slate-500',
    border: 'border-slate-200 dark:border-zinc-700',
    bg: 'bg-slate-50 dark:bg-zinc-800/40',
    textAccent: 'text-slate-600 dark:text-zinc-300',
  },
]

function CheckCard({ check, index }: { check: typeof CHECKS[0]; index: number }) {
  const [open, setOpen] = useState(false)
  const ref = useReveal()

  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${index * 100}ms` }}>
      <button
        onClick={() => setOpen(!open)}
        className={`w-full text-left rounded-2xl border transition-all duration-300 overflow-hidden ${
          open ? `${check.border} ${check.bg}` : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:border-slate-300 dark:hover:border-zinc-700'
        }`}
      >
        <div className="flex items-center gap-5 p-6">
          <div className={`flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br ${check.accent} flex items-center justify-center shadow-lg`}>
            <check.icon className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-slate-900 dark:text-white font-semibold text-base mb-1">{check.title}</div>
            <div className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{check.tagline}</div>
          </div>
          <ChevronRight className={`w-5 h-5 text-slate-400 dark:text-zinc-500 flex-shrink-0 transition-transform duration-300 ${open ? 'rotate-90' : ''}`} />
        </div>

        <div className={`overflow-hidden transition-all duration-500 ${open ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-6 pb-6 border-t border-slate-100 dark:border-zinc-800 pt-5 space-y-4">
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${check.textAccent}`}>How it works</div>
              <p className="text-slate-600 dark:text-zinc-300 text-sm leading-relaxed">{check.how}</p>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-slate-400 dark:text-zinc-500">Why it matters</div>
              <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{check.why}</p>
            </div>
          </div>
        </div>
      </button>
    </div>
  )
}

// ─── Without vs With toggle ───────────────────────────────────────────────────

const WITHOUT_SCENARIOS = [
  { issue: 'Customer emails about missing order', outcome: 'Two agents pick it up separately — both resolve it, customer gets two conflicting replies', bad: true },
  { issue: 'Same complaint via chat 10 min later', outcome: 'Counted as a second case, inflates ticket volume metrics', bad: true },
  { issue: 'Policy conflict on payment dispute', outcome: 'Cardinal picks one rule arbitrarily — wrong resolution applied', bad: true },
  { issue: 'Blank form submission from API test', outcome: 'Causes a null-pointer in the classification stage — silent failure', bad: true },
]
const WITH_SCENARIOS = [
  { issue: 'Customer emails about missing order', outcome: 'Case T-001 created. Enters Cardinal cleanly.', bad: false },
  { issue: 'Same complaint via chat 10 min later', outcome: 'L2 detects duplicate of T-001. Merged. No double handling.', bad: false },
  { issue: 'Policy conflict on payment dispute', outcome: 'L2 flags ambiguity. Ops team alerted. Ticket held pending resolution.', bad: false },
  { issue: 'Blank form submission from API test', outcome: 'Rejected at the gate with reason code. Pipeline never touched.', bad: false },
]

function CompareToggle() {
  const [withL2, setWithL2] = useState(false)
  const scenarios = withL2 ? WITH_SCENARIOS : WITHOUT_SCENARIOS

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
      {/* Toggle */}
      <div className="flex border-b border-slate-100 dark:border-zinc-800">
        <button
          onClick={() => setWithL2(false)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            !withL2
              ? 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 border-b-2 border-red-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          Without L2 Validator
        </button>
        <button
          onClick={() => setWithL2(true)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            withL2
              ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          With L2 Validator
        </button>
      </div>

      {/* Scenarios */}
      <div className="divide-y divide-slate-100 dark:divide-zinc-800">
        {scenarios.map((s, i) => (
          <div key={i} className="flex items-start gap-4 p-4">
            {s.bad
              ? <XCircle className="w-4 h-4 mt-0.5 text-red-400 flex-shrink-0" />
              : <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
            }
            <div>
              <div className="text-slate-500 dark:text-zinc-400 text-xs mb-1">{s.issue}</div>
              <div className={`text-sm font-medium ${s.bad ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                → {s.outcome}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function L2ValidatorPage() {
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
        <div className="orb-drift absolute -top-32 left-1/4 w-[600px] h-[500px] rounded-full bg-violet-600/10 dark:bg-violet-600/12 blur-[120px] pointer-events-none" />
        <div className="orb-drift-2 absolute top-20 right-1/4 w-[400px] h-[400px] rounded-full bg-blue-600/8 dark:bg-blue-600/10 blur-[100px] pointer-events-none" />

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="hero-in-1 inline-flex items-center gap-2 rounded-full border border-violet-200 dark:border-violet-900/60 bg-violet-50 dark:bg-violet-950/30 px-4 py-1.5 text-xs text-violet-600 dark:text-violet-400 font-medium mb-8">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
            Deduplication · Conflict detection · Schema validation
          </div>

          <h1 className="hero-in-2 text-5xl md:text-6xl font-bold leading-[1.06] tracking-tight mb-6">
            <span className="text-slate-900 dark:text-white">L2 Validator:</span>
            <br />
            <span className="bg-gradient-to-r from-violet-500 via-blue-500 to-violet-400 bg-clip-text text-transparent">
              Nothing Slips Through
            </span>
          </h1>

          <p className="hero-in-3 text-slate-500 dark:text-zinc-400 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            Before any ticket reaches a decision, L2 checks it for duplicates, policy conflicts, and missing data.
            Only clean, unique, actionable cases move forward.
          </p>

          {/* Visual: inbox → filter → clean */}
          <div className="mt-14 flex items-center justify-center gap-4 flex-wrap">
            {[
              { label: 'Raw tickets', note: 'any state', color: 'border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-zinc-300' },
            ].map((item) => (
              <div key={item.label} className={`px-5 py-3 rounded-xl border ${item.color} bg-white/60 dark:bg-zinc-900/60 backdrop-blur-sm`}>
                <div className="font-semibold text-sm">{item.label}</div>
                <div className="text-xs text-slate-400 dark:text-zinc-500">{item.note}</div>
              </div>
            ))}
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border-2 border-violet-500 bg-violet-50 dark:bg-violet-950/30 shadow-lg shadow-violet-500/20">
              <div className="font-semibold text-sm text-violet-700 dark:text-violet-300">L2 Validator</div>
              <div className="text-xs text-violet-500 dark:text-violet-400">screens everything</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30">
              <div className="font-semibold text-sm text-emerald-700 dark:text-emerald-300">Clean cases only</div>
              <div className="text-xs text-emerald-500 dark:text-emerald-400">reach Cardinal</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Where it sits in the pipeline ───────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-5xl">
          <RevealSection className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-200 dark:border-violet-900/60 bg-violet-50 dark:bg-violet-950/30 px-4 py-1.5 text-xs text-violet-600 dark:text-violet-400 font-medium mb-4">
              Pipeline Position
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              First in line. Always.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              L2 runs before Cardinal, before any agent sees the ticket. Hover each step to understand what it does.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <PipelinePosition />
          </RevealSection>
        </div>
      </section>

      {/* ── Three checks ─────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-violet-600/3 dark:bg-violet-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-4xl relative">
          <RevealSection className="text-center mb-14">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 font-medium mb-4">
              What L2 checks
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              Three gates. Every ticket passes all three.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Click any check to see exactly what it catches and why it matters.
            </p>
          </RevealSection>
          <div className="space-y-4">
            {CHECKS.map((check, i) => (
              <CheckCard key={check.title} check={check} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Interactive demo ─────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-4xl">
          <RevealSection className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400 font-medium mb-4">
              Live example
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              See what L2 catches in a real ticket stream
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Filter by outcome to see how L2 categorises each case.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <CatchDemo />
          </RevealSection>
        </div>
      </section>

      {/* ── Without vs With ──────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-blue-600/3 dark:bg-blue-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-3xl relative">
          <RevealSection className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              The same four tickets.<br />
              <span className="bg-gradient-to-r from-violet-500 to-blue-500 bg-clip-text text-transparent">A very different outcome.</span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Toggle to see what happens with and without L2 Validator in the pipeline.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <CompareToggle />
          </RevealSection>
        </div>
      </section>

      {/* ── What it protects ─────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What L2 protects downstream
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              A clean input is the foundation of a trustworthy output. L2 makes sure the whole chain holds.
            </p>
          </RevealSection>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              { icon: Layers,      title: 'Cleaner reporting',    desc: 'Ticket counts reflect real cases — not duplicates inflating volume metrics.', accent: 'text-violet-500' },
              { icon: ShieldCheck, title: 'Accurate decisions',   desc: 'Cardinal only sees unambiguous inputs. No conflicting policies, no missing context.', accent: 'text-blue-500' },
              { icon: Filter,      title: 'Faster resolution',    desc: 'Agents work unique cases only. No double-handling of the same complaint.', accent: 'text-emerald-500' },
              { icon: AlertTriangle, title: 'No silent failures', desc: 'Malformed inputs are rejected at the gate — they never cause mid-pipeline errors.', accent: 'text-amber-500' },
            ].map((item, i) => (
              <RevealSection key={item.title} delay={i * 80}>
                <div className="h-full rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-6 hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/30 transition-all duration-300">
                  <item.icon className={`w-7 h-7 mb-4 ${item.accent}`} />
                  <h3 className="text-slate-900 dark:text-white font-semibold mb-2">{item.title}</h3>
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
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-violet-600/5 dark:bg-violet-600/8 blur-[100px]" />
        </div>
        <RevealSection className="mx-auto max-w-3xl text-center relative">
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
            A clean pipeline starts at the gate.
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-10">
            L2 Validator is built into every Auralis deployment. It runs automatically, on every ticket, without configuration.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button onClick={() => navigate('/signup')}
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white font-semibold text-sm transition-all shadow-xl shadow-violet-600/25 hover:shadow-violet-600/40 hover:-translate-y-0.5">
              Get Started Free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <button onClick={() => navigate('/how-it-works')}
              className="px-10 py-4 rounded-xl border border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-500 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white font-medium text-sm transition-all hover:-translate-y-0.5">
              See the full Cardinal pipeline
            </button>
          </div>
        </RevealSection>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 dark:border-zinc-900 py-8 px-6">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-400 dark:text-zinc-500 text-sm">
            <div className="flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-violet-600 to-blue-600">
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
