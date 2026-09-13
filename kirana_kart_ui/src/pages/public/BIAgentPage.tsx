import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart3, BarChart2, Users, TrendingUp, AlertTriangle, Clock,
  MessageSquare, Cpu, ArrowRight, Sun, Moon, Zap,
  ChevronRight, Search, CheckCircle2, XCircle,
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
            className="text-white text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 transition-all shadow-lg shadow-emerald-600/20">
            Sign Up
          </button>
        </div>
      </div>
    </nav>
  )
}

// ─── Question Grid ────────────────────────────────────────────────────────────

interface Question {
  q: string
  category: string
  icon: React.ElementType
  result: string
  accent: string
}

const QUESTIONS: Question[] = [
  {
    q: 'How many tickets came in this week?',
    category: 'Volume',
    icon: BarChart3,
    result: 'A bar chart showing daily ticket counts Mon–Sun, with totals per day.',
    accent: 'from-emerald-600 to-teal-500',
  },
  {
    q: 'Which agents resolved the most cases today?',
    category: 'Performance',
    icon: Users,
    result: 'A ranked table: Agent name | Cases closed | Avg handle time.',
    accent: 'from-teal-600 to-cyan-500',
  },
  {
    q: 'Show me refund volume by month for this quarter',
    category: 'Trends',
    icon: TrendingUp,
    result: 'A line chart showing refund count per month, with month-over-month delta.',
    accent: 'from-emerald-600 to-teal-500',
  },
  {
    q: 'Which issue type had the highest spike yesterday?',
    category: 'Anomalies',
    icon: AlertTriangle,
    result: '"Delivery delay" complaints were 3× higher than the 7-day average. Shown as a highlighted bar.',
    accent: 'from-teal-600 to-cyan-500',
  },
  {
    q: 'Which customers submitted more than 3 complaints?',
    category: 'Customer',
    icon: Search,
    result: 'A table listing customer IDs, complaint count, and most recent issue type.',
    accent: 'from-emerald-600 to-teal-500',
  },
  {
    q: 'How many tickets breached SLA this quarter?',
    category: 'SLA',
    icon: Clock,
    result: 'A number card: total breaches, broken down by team and ticket priority.',
    accent: 'from-teal-600 to-cyan-500',
  },
]

function QuestionCard({ item, index }: { item: Question; index: number }) {
  const [open, setOpen] = useState(false)
  const ref = useReveal()
  const Icon = item.icon

  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${index * 80}ms` }}>
      <button
        onClick={() => setOpen(!open)}
        className={`w-full text-left rounded-2xl border transition-all duration-300 overflow-hidden ${
          open
            ? 'border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20'
            : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:border-slate-300 dark:hover:border-zinc-700'
        }`}
      >
        <div className="flex items-start gap-4 p-5">
          <div className={`flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br ${item.accent} flex items-center justify-center shadow-md`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60">
                {item.category}
              </span>
            </div>
            <div className="text-slate-800 dark:text-zinc-100 text-sm font-medium leading-snug">
              "{item.q}"
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-slate-400 dark:text-zinc-500 flex-shrink-0 mt-1 transition-transform duration-300 ${open ? 'rotate-90' : ''}`} />
        </div>

        <div className={`overflow-hidden transition-all duration-500 ${open ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-5 pb-5 border-t border-slate-100 dark:border-zinc-800 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-emerald-600 dark:text-emerald-400">
              → Result
            </div>
            <p className="text-slate-600 dark:text-zinc-300 text-sm leading-relaxed">{item.result}</p>
          </div>
        </div>
      </button>
    </div>
  )
}

function QuestionGrid() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {QUESTIONS.map((item, i) => (
        <QuestionCard key={item.q} item={item} index={i} />
      ))}
    </div>
  )
}

// ─── Three-Step Stepper ───────────────────────────────────────────────────────

function HowItWorks() {
  const [hoveredStep, setHoveredStep] = useState<number | null>(null)

  const steps = [
    {
      label: 'You ask',
      sub: 'Plain English, any question',
      icon: MessageSquare,
      color: 'from-slate-500 to-slate-400',
      active: false,
    },
    {
      label: 'BI Agent reads',
      sub: 'Maps question to live data',
      icon: Cpu,
      color: 'from-emerald-600 to-teal-500',
      active: true,
    },
    {
      label: 'You get an answer',
      sub: 'Number, table, or chart',
      icon: BarChart2,
      color: 'from-teal-600 to-cyan-500',
      active: false,
    },
  ]

  const tooltips: Record<number, string> = {
    0: "Just type what you want to know. 'How many P1 tickets did we close last week?' is a valid question.",
    1: "The BI Agent understands ops terminology — 'tickets', 'agents', 'SLA breach', 'refund' — and translates to the correct data query automatically.",
    2: "You see the answer right away. If you want to drill down, ask the follow-up — 'Break that down by agent' — and it runs a new query immediately.",
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
                  ? 'scale-110 ring-4 ring-emerald-500/30 shadow-emerald-500/30'
                  : 'hover:scale-105'
              }`}
            >
              <step.icon className="w-6 h-6 text-white" />
              {step.active && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-emerald-400 rounded-full border-2 border-white dark:border-zinc-900 pulse-slow" />
              )}
            </button>

            {/* Label */}
            <div className="sm:text-center mt-0 sm:mt-3">
              <div className={`text-sm font-semibold ${step.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-zinc-200'}`}>
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
            ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-300'
            : 'bg-slate-50 dark:bg-zinc-800/60 border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300'
        } text-sm leading-relaxed`}>
          {tooltips[hoveredStep]}
        </div>
      )}
      {hoveredStep === null && (
        <p className="mt-6 text-xs text-slate-400 dark:text-zinc-500 text-center">
          Hover or tap any step to see what happens there.
        </p>
      )}
    </div>
  )
}

// ─── Compare Toggle ───────────────────────────────────────────────────────────

const WITHOUT_SCENARIOS = [
  { issue: 'Manager asks: How many P1s did we close last week?', outcome: 'Someone pulls a CSV, opens Excel, filters, sends it back. 2 days later.' },
  { issue: 'Need to know which agent handles refunds fastest', outcome: 'Manual review of resolved tickets. Takes hours. Often not done.' },
  { issue: 'Spot a spike in delivery complaints', outcome: 'Nobody notices until a customer escalates to the CEO.' },
  { issue: 'Month-end ops report due tomorrow', outcome: 'All-nighter pulling data from three different tools.' },
]

const WITH_SCENARIOS = [
  { issue: 'Manager asks: How many P1s did we close last week?', outcome: '"Show me P1 closures last week" → answer in seconds, with a chart.' },
  { issue: 'Need to know which agent handles refunds fastest', outcome: '"Who resolves refund tickets fastest?" → ranked table, instantly.' },
  { issue: 'Spot a spike in delivery complaints', outcome: 'The data is always there. Ask "What spiked yesterday?" any time.' },
  { issue: 'Month-end ops report due tomorrow', outcome: 'Ask 12 questions in 5 minutes. Answers ready. Report done.' },
]

function CompareToggle() {
  const [withAgent, setWithAgent] = useState(false)
  const scenarios = withAgent ? WITH_SCENARIOS : WITHOUT_SCENARIOS

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
      {/* Toggle */}
      <div className="flex border-b border-slate-100 dark:border-zinc-800">
        <button
          onClick={() => setWithAgent(false)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            !withAgent
              ? 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 border-b-2 border-red-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          Without BI Agent
        </button>
        <button
          onClick={() => setWithAgent(true)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            withAgent
              ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          With BI Agent
        </button>
      </div>

      {/* Scenarios */}
      <div className="divide-y divide-slate-100 dark:divide-zinc-800">
        {scenarios.map((s, i) => (
          <div key={i} className="flex items-start gap-4 p-4">
            {!withAgent
              ? <XCircle className="w-4 h-4 mt-0.5 text-red-400 flex-shrink-0" />
              : <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
            }
            <div>
              <div className="text-slate-500 dark:text-zinc-400 text-xs mb-1">{s.issue}</div>
              <div className={`text-sm font-medium ${!withAgent ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
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

export default function BIAgentPage() {
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
        <div className="orb-drift absolute -top-32 left-1/4 w-[600px] h-[500px] rounded-full bg-emerald-600/10 dark:bg-emerald-600/12 blur-[120px] pointer-events-none" />
        <div className="orb-drift-2 absolute top-20 right-1/4 w-[400px] h-[400px] rounded-full bg-teal-600/8 dark:bg-teal-600/10 blur-[100px] pointer-events-none" />

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="hero-in-1 inline-flex items-center gap-2 rounded-full border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium mb-8">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-slow" />
            Plain English · Live data · Instant answers
          </div>

          <h1 className="hero-in-2 text-5xl md:text-6xl font-bold leading-[1.06] tracking-tight mb-6">
            <span className="text-slate-900 dark:text-white">BI Agent:</span>
            <br />
            <span className="bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400 bg-clip-text text-transparent">
              Ask. Get the Answer.
            </span>
          </h1>

          <p className="hero-in-3 text-slate-500 dark:text-zinc-400 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            Type a question about your operations in plain English. The BI Agent reads your live data
            and returns the answer — a number, a table, or a chart — immediately. No SQL, no data team, no waiting.
          </p>

          {/* Visual flow */}
          <div className="mt-14 flex items-center justify-center gap-4 flex-wrap">
            <div className="px-5 py-3 rounded-xl border border-slate-300 dark:border-zinc-600 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-sm">
              <div className="font-semibold text-sm text-slate-700 dark:text-zinc-200">Your question</div>
              <div className="text-xs text-slate-400 dark:text-zinc-500">plain English</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 shadow-lg shadow-emerald-500/20">
              <div className="font-semibold text-sm text-emerald-700 dark:text-emerald-300">BI Agent</div>
              <div className="text-xs text-emerald-500 dark:text-emerald-400">reads live data</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border border-teal-300 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/30">
              <div className="font-semibold text-sm text-teal-700 dark:text-teal-300">Instant answer</div>
              <div className="text-xs text-teal-500 dark:text-teal-400">number, table, or chart</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── What you can ask ─────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium mb-4">
              Interactive examples
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What can you ask?
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Any question about your tickets, agents, customers, or trends — as long as it's in plain English.
              Click any card to see a sample result.
            </p>
          </RevealSection>
          <QuestionGrid />
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-emerald-600/3 dark:bg-emerald-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-5xl relative">
          <RevealSection className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 font-medium mb-4">
              How it works
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              Three steps. One answer.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Hover each step to see what happens.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <HowItWorks />
          </RevealSection>
        </div>
      </section>

      {/* ── What it covers ───────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What the BI Agent covers
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Any question across these domains can be answered immediately.
            </p>
          </RevealSection>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                icon: BarChart3,
                title: 'Ticket volume & trends',
                desc: 'Daily, weekly, monthly ticket counts by type, channel, priority, or status.',
                accent: 'text-emerald-500',
              },
              {
                icon: Users,
                title: 'Agent performance',
                desc: 'Cases resolved, average handle time, first-contact resolution rate — per agent or team.',
                accent: 'text-teal-500',
              },
              {
                icon: Clock,
                title: 'SLA compliance',
                desc: 'Which tickets breached SLA, which are at risk, and where the bottlenecks are.',
                accent: 'text-cyan-500',
              },
              {
                icon: TrendingUp,
                title: 'Complaint patterns',
                desc: 'Which issue types are rising, which customers are repeat complainants, and where volume is shifting.',
                accent: 'text-emerald-500',
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

      {/* ── Without vs With ──────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-teal-600/3 dark:bg-teal-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-3xl relative">
          <RevealSection className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              The same question.<br />
              <span className="bg-gradient-to-r from-emerald-500 to-teal-500 bg-clip-text text-transparent">
                A very different outcome.
              </span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Toggle to see what happens with and without the BI Agent.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <CompareToggle />
          </RevealSection>
        </div>
      </section>

      {/* ── Footer CTA ───────────────────────────────────────────────────────── */}
      <section className="py-28 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-emerald-600/5 dark:bg-emerald-600/8 blur-[100px]" />
        </div>
        <RevealSection className="mx-auto max-w-3xl text-center relative">
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
            Your ops data, finally accessible.
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-10">
            The BI Agent is part of every Auralis deployment. Ask your first question the day you go live.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button onClick={() => navigate('/signup')}
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-semibold text-sm transition-all shadow-xl shadow-emerald-600/25 hover:shadow-emerald-600/40 hover:-translate-y-0.5">
              Get Started Free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <button onClick={() => navigate('/how-it-works')}
              className="px-10 py-4 rounded-xl border border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-500 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white font-medium text-sm transition-all hover:-translate-y-0.5">
              See how Cardinal works
            </button>
          </div>
        </RevealSection>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 dark:border-zinc-900 py-8 px-6">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-400 dark:text-zinc-500 text-sm">
            <div className="flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-emerald-600 to-teal-500">
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
