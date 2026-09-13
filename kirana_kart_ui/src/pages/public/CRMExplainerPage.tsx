import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Inbox, Users, Clock, AlertTriangle, CheckCircle2, Bell,
  GitMerge, Star, TrendingUp, LayoutGrid, ArrowRight,
  Sun, Moon, Zap, ChevronRight, XCircle,
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

// ─── Lifecycle Stepper ────────────────────────────────────────────────────────

const STAGES = [
  {
    label: 'Intake',
    sub: 'SLA clock starts',
    icon: Inbox,
    color: 'from-slate-500 to-slate-400',
  },
  {
    label: 'Assigned',
    sub: 'Routed to the right team',
    icon: Users,
    color: 'from-rose-600 to-rose-500',
  },
  {
    label: 'In Progress',
    sub: 'SLA countdown live',
    icon: Clock,
    color: 'from-amber-600 to-amber-500',
  },
  {
    label: 'Escalated (if needed)',
    sub: 'Auto-triggered on threshold',
    icon: AlertTriangle,
    color: 'from-orange-600 to-orange-500',
  },
  {
    label: 'Resolved',
    sub: 'Closed, logged, CSAT sent',
    icon: CheckCircle2,
    color: 'from-emerald-600 to-emerald-500',
  },
]

const STAGE_TOOLTIPS: Record<number, string> = {
  0: "When a ticket arrives — email, chat, form, or API — the CRM creates a case record, assigns an SLA tier based on priority, and starts the countdown.",
  1: "Based on issue type and current agent workload, the ticket is routed to the correct team or individual. No manual triage needed.",
  2: "The agent can see the SLA countdown on their dashboard. If a response or resolution is overdue, a reminder fires automatically.",
  3: "If the SLA threshold is about to breach — or has breached — the system escalates automatically. The supervisor is notified. Nothing is missed silently.",
  4: "On resolution, the case is closed with a full audit trail. A CSAT survey goes out to the customer. The ticket is logged for QA scoring.",
}

function LifecycleStepper() {
  const [hoveredStep, setHoveredStep] = useState<number | null>(null)

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-8">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-0">
        {STAGES.map((stage, i) => (
          <div key={stage.label} className="flex sm:flex-col items-center sm:flex-1 gap-3 sm:gap-0">
            {/* Node */}
            <button
              onMouseEnter={() => setHoveredStep(i)}
              onMouseLeave={() => setHoveredStep(null)}
              onClick={() => setHoveredStep(hoveredStep === i ? null : i)}
              className={`relative flex-shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br ${stage.color} flex items-center justify-center shadow-lg transition-all duration-300 hover:scale-105 ${
                hoveredStep === i ? 'scale-110 ring-4 ring-rose-500/30 shadow-rose-500/20' : ''
              }`}
            >
              <stage.icon className="w-6 h-6 text-white" />
            </button>

            {/* Label */}
            <div className="sm:text-center mt-0 sm:mt-3">
              <div className={`text-sm font-semibold ${
                hoveredStep === i ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-zinc-200'
              }`}>
                {stage.label}
              </div>
              <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{stage.sub}</div>
            </div>

            {/* Connector */}
            {i < STAGES.length - 1 && (
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
        <div className="mt-6 p-4 rounded-xl border bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800/50 text-rose-700 dark:text-rose-300 text-sm leading-relaxed transition-all">
          {STAGE_TOOLTIPS[hoveredStep]}
        </div>
      )}
      {hoveredStep === null && (
        <p className="mt-6 text-xs text-slate-400 dark:text-zinc-500 text-center">
          Hover or tap any stage to see what the CRM does at that point.
        </p>
      )}
    </div>
  )
}

// ─── Automation Cards ─────────────────────────────────────────────────────────

const AUTOMATIONS = [
  {
    icon: Bell,
    title: 'Auto-follow-up',
    tagline: 'No agent response in N hours? A reminder goes out — to the agent, not the customer.',
    how: 'If a ticket has been assigned but not responded to within the configured time window, the assigned agent receives an internal reminder. If still no response after a second window, the supervisor is notified.',
    why: 'Response SLAs are often breached not from overload but from tickets being forgotten in a queue. Auto-follow-up catches those before the customer notices.',
    accent: 'from-rose-600 to-rose-500',
    border: 'border-rose-200 dark:border-rose-900/50',
    bg: 'bg-rose-50 dark:bg-rose-950/20',
    textAccent: 'text-rose-600 dark:text-rose-400',
  },
  {
    icon: AlertTriangle,
    title: 'Auto-escalation',
    tagline: 'SLA breach imminent? Supervisor notified before the customer feels it.',
    how: 'When a ticket reaches 80% of its SLA window without resolution, the system flags it and notifies the team lead. The agent gets a visual warning on their dashboard.',
    why: 'Waiting for the SLA to breach before acting is always too late. Auto-escalation creates time to intervene — not just to apologise.',
    accent: 'from-orange-600 to-amber-500',
    border: 'border-orange-200 dark:border-orange-900/50',
    bg: 'bg-orange-50 dark:bg-orange-950/20',
    textAccent: 'text-orange-600 dark:text-orange-400',
  },
  {
    icon: GitMerge,
    title: 'Auto-merge',
    tagline: 'Same customer, same issue, different channel — merged into one case.',
    how: 'When L2 detects a duplicate across channels, the CRM automatically merges the cases under the earliest ticket ID. The agent works one case; the customer gets one response.',
    why: 'Duplicate cases inflate volume metrics and create the risk of inconsistent responses to the same customer. Merging keeps the record clean.',
    accent: 'from-violet-600 to-violet-500',
    border: 'border-violet-200 dark:border-violet-900/50',
    bg: 'bg-violet-50 dark:bg-violet-950/20',
    textAccent: 'text-violet-600 dark:text-violet-400',
  },
  {
    icon: Star,
    title: 'Auto-CSAT',
    tagline: 'Case closed? Customer satisfaction request goes out automatically.',
    how: 'After a ticket is resolved and closed, a CSAT survey is triggered through the same channel the customer used. Responses are logged against the ticket and the agent.',
    why: 'Manual CSAT collection is inconsistent — some agents send it, some forget. Automatic triggering means every closure gets measured.',
    accent: 'from-pink-600 to-rose-500',
    border: 'border-pink-200 dark:border-pink-900/50',
    bg: 'bg-pink-50 dark:bg-pink-950/20',
    textAccent: 'text-pink-600 dark:text-pink-400',
  },
]

function AutomationCard({ auto, index }: { auto: typeof AUTOMATIONS[0]; index: number }) {
  const [open, setOpen] = useState(false)
  const ref = useReveal()

  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${index * 100}ms` }}>
      <button
        onClick={() => setOpen(!open)}
        className={`w-full text-left rounded-2xl border transition-all duration-300 overflow-hidden ${
          open ? `${auto.border} ${auto.bg}` : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:border-slate-300 dark:hover:border-zinc-700'
        }`}
      >
        <div className="flex items-center gap-5 p-6">
          <div className={`flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br ${auto.accent} flex items-center justify-center shadow-lg`}>
            <auto.icon className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-slate-900 dark:text-white font-semibold text-base mb-1">{auto.title}</div>
            <div className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{auto.tagline}</div>
          </div>
          <ChevronRight className={`w-5 h-5 text-slate-400 dark:text-zinc-500 flex-shrink-0 transition-transform duration-300 ${open ? 'rotate-90' : ''}`} />
        </div>

        <div className={`overflow-hidden transition-all duration-500 ${open ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-6 pb-6 border-t border-slate-100 dark:border-zinc-800 pt-5 space-y-4">
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${auto.textAccent}`}>How it works</div>
              <p className="text-slate-600 dark:text-zinc-300 text-sm leading-relaxed">{auto.how}</p>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-slate-400 dark:text-zinc-500">Why it matters</div>
              <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{auto.why}</p>
            </div>
          </div>
        </div>
      </button>
    </div>
  )
}

// ─── Compare Toggle ───────────────────────────────────────────────────────────

const WITHOUT_CRM = [
  { issue: 'High-priority ticket submitted at 4pm Friday', outcome: 'Sits in shared inbox. Not picked up until Monday morning. Customer escalates.' },
  { issue: 'SLA breach on a VIP customer', outcome: 'Nobody knew until the complaint landed in the CEO inbox.' },
  { issue: 'Same customer emails and chats about the same issue', outcome: 'Two agents pick it up. Two different answers sent. Customer confused.' },
  { issue: 'Agent closes a ticket without sending CSAT', outcome: 'No feedback collected. No coaching opportunity.' },
]

const WITH_CRM = [
  { issue: 'High-priority ticket submitted at 4pm Friday', outcome: 'Auto-assigned, SLA clock running. On-call agent notified immediately.' },
  { issue: 'SLA breach on a VIP customer', outcome: 'Flagged at 80% of SLA window. Supervisor alerted. Resolved before breach.' },
  { issue: 'Same customer emails and chats about the same issue', outcome: 'L2 detects duplicate. CRM merges. One agent. One response. One case.' },
  { issue: 'Agent closes a ticket without sending CSAT', outcome: 'CSAT triggered automatically on closure. No action required from the agent.' },
]

function CompareToggle() {
  const [withCRM, setWithCRM] = useState(false)
  const scenarios = withCRM ? WITH_CRM : WITHOUT_CRM

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
      {/* Toggle */}
      <div className="flex border-b border-slate-100 dark:border-zinc-800">
        <button
          onClick={() => setWithCRM(false)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            !withCRM
              ? 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 border-b-2 border-red-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          Without CRM &amp; Ops
        </button>
        <button
          onClick={() => setWithCRM(true)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            withCRM
              ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          With CRM &amp; Ops
        </button>
      </div>

      {/* Scenarios */}
      <div className="divide-y divide-slate-100 dark:divide-zinc-800">
        {scenarios.map((s, i) => (
          <div key={i} className="flex items-start gap-4 p-4">
            {!withCRM
              ? <XCircle className="w-4 h-4 mt-0.5 text-red-400 flex-shrink-0" />
              : <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
            }
            <div>
              <div className="text-slate-500 dark:text-zinc-400 text-xs mb-1">{s.issue}</div>
              <div className={`text-sm font-medium ${!withCRM ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
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

export default function CRMExplainerPage() {
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
        <div className="orb-drift absolute -top-32 left-1/4 w-[600px] h-[500px] rounded-full bg-rose-600/10 dark:bg-rose-600/12 blur-[120px] pointer-events-none" />
        <div className="orb-drift-2 absolute top-20 right-1/4 w-[400px] h-[400px] rounded-full bg-pink-600/8 dark:bg-pink-600/10 blur-[100px] pointer-events-none" />

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="hero-in-1 inline-flex items-center gap-2 rounded-full border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 px-4 py-1.5 text-xs text-rose-600 dark:text-rose-400 font-medium mb-8">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-400 pulse-slow" />
            SLA tracking · Automation rules · Full audit trail
          </div>

          <h1 className="hero-in-2 text-5xl md:text-6xl font-bold leading-[1.06] tracking-tight mb-6">
            <span className="text-slate-900 dark:text-white">CRM &amp; Ticket Ops:</span>
            <br />
            <span className="bg-gradient-to-r from-rose-500 via-pink-500 to-rose-400 bg-clip-text text-transparent">
              Every Case. Every Deadline.
            </span>
          </h1>

          <p className="hero-in-3 text-slate-500 dark:text-zinc-400 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            Your operations team needs to see every open ticket, know what's at risk, and trust that nothing slips through.
            CRM &amp; Ticket Ops is the command centre that makes that possible.
          </p>

          {/* Visual flow: Ticket created → CRM & Ops → Resolved on time */}
          <div className="mt-14 flex items-center justify-center gap-4 flex-wrap">
            <div className="px-5 py-3 rounded-xl border border-slate-300 dark:border-zinc-600 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-sm">
              <div className="font-semibold text-sm text-slate-700 dark:text-zinc-200">Ticket created</div>
              <div className="text-xs text-slate-400 dark:text-zinc-500">any channel</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border-2 border-rose-500 bg-rose-50 dark:bg-rose-950/30 shadow-lg shadow-rose-500/20">
              <div className="font-semibold text-sm text-rose-700 dark:text-rose-300">CRM &amp; Ops</div>
              <div className="text-xs text-rose-500 dark:text-rose-400">tracks everything</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30">
              <div className="font-semibold text-sm text-emerald-700 dark:text-emerald-300">Resolved on time</div>
              <div className="text-xs text-emerald-500 dark:text-emerald-400">with full audit</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Ticket Lifecycle Stepper ─────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-5xl">
          <RevealSection className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 px-4 py-1.5 text-xs text-rose-600 dark:text-rose-400 font-medium mb-4">
              Ticket Lifecycle
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              From open to closed — every step tracked.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Hover or tap each stage to see what the CRM does at that point.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <LifecycleStepper />
          </RevealSection>
        </div>
      </section>

      {/* ── Automation Rules ──────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-rose-600/3 dark:bg-rose-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-4xl relative">
          <RevealSection className="text-center mb-14">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 font-medium mb-4">
              Automation Rules
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              The automations that run in the background.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Rules that trigger based on time, status, or event — so your team doesn't have to remember.
            </p>
          </RevealSection>
          <div className="space-y-4">
            {AUTOMATIONS.map((auto, i) => (
              <AutomationCard key={auto.title} auto={auto} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Compare Toggle ────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-pink-600/3 dark:bg-pink-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-3xl relative">
          <RevealSection className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              The same ticket.<br />
              <span className="bg-gradient-to-r from-rose-500 to-pink-500 bg-clip-text text-transparent">
                A very different outcome.
              </span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Toggle to see what happens with and without CRM &amp; Ops in your workflow.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <CompareToggle />
          </RevealSection>
        </div>
      </section>

      {/* ── What your team sees ───────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What your team sees
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              One dashboard. Every metric that matters to keeping SLAs and customers happy.
            </p>
          </RevealSection>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                icon: LayoutGrid,
                title: 'Full caseload view',
                desc: 'Every open ticket visible in one place — status, priority, owner, and SLA remaining.',
                accent: 'text-rose-500',
              },
              {
                icon: Clock,
                title: 'SLA compliance',
                desc: 'Real-time countdown per ticket. Risk flagged before breach, not after.',
                accent: 'text-pink-500',
              },
              {
                icon: Users,
                title: 'Agent workload',
                desc: 'Distribution across your team. No single agent overwhelmed while others have capacity.',
                accent: 'text-rose-500',
              },
              {
                icon: TrendingUp,
                title: 'Resolution trends',
                desc: 'Track closure rates, average handle times, and CSAT trends over time.',
                accent: 'text-pink-500',
              },
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
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-rose-600/5 dark:bg-rose-600/8 blur-[100px]" />
        </div>
        <RevealSection className="mx-auto max-w-3xl text-center relative">
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
            Give your team the command centre they need.
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-10">
            CRM &amp; Ticket Ops is built into every Auralis deployment — live from day one, no setup required.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button onClick={() => navigate('/signup')}
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white font-semibold text-sm transition-all shadow-xl shadow-rose-600/25 hover:shadow-rose-600/40 hover:-translate-y-0.5">
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
            <div className="flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-rose-600 to-pink-600">
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
