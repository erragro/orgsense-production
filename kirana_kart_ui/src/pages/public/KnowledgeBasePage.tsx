import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen, GitBranch, Search, Lock, Shield, Clock, FileText,
  CheckCircle2, Cpu, ArrowRight, Sun, Moon, Zap, ChevronRight, XCircle,
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

// ─── Write · Test · Publish stepper ──────────────────────────────────────────

function WorkflowStepper() {
  const [hoveredStep, setHoveredStep] = useState<number | null>(null)

  const steps = [
    {
      label: 'Write your SOP',
      sub: 'structured format',
      icon: FileText,
      color: 'from-slate-500 to-slate-400',
      active: false,
    },
    {
      label: 'Simulate',
      sub: 'test before publish',
      icon: Cpu,
      color: 'from-cyan-600 to-cyan-500',
      active: true,
    },
    {
      label: 'Publish',
      sub: 'Cardinal reads it instantly',
      icon: CheckCircle2,
      color: 'from-emerald-600 to-emerald-500',
      active: false,
    },
  ]

  const tooltips: Record<number, string> = {
    0: 'Describe your policy in plain language or structured format. Define the trigger (issue type), the condition (e.g. order age), and the action (e.g. approve refund up to ₹500).',
    1: 'Before publishing, run the policy against example cases. See what it would have decided on historical tickets. Catch edge cases before they reach customers.',
    2: 'Once published, the policy is locked at that version. Cardinal reads it immediately. Future changes require a new version — the history is always preserved.',
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
                  ? 'scale-110 ring-4 ring-cyan-500/30 shadow-cyan-500/30'
                  : 'hover:scale-105'
              }`}
            >
              <step.icon className="w-6 h-6 text-white" />
              {step.active && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-cyan-400 rounded-full border-2 border-white dark:border-zinc-900 pulse-slow" />
              )}
            </button>

            {/* Label */}
            <div className="sm:text-center mt-0 sm:mt-3">
              <div className={`text-sm font-semibold ${step.active ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-700 dark:text-zinc-200'}`}>
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
            ? 'bg-cyan-50 dark:bg-cyan-950/30 border-cyan-200 dark:border-cyan-800/50 text-cyan-700 dark:text-cyan-300'
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

// ─── Capability cards ─────────────────────────────────────────────────────────

const CAPABILITIES = [
  {
    icon: GitBranch,
    title: 'Version Control',
    tagline: 'Every change saved. Every version retrievable. No accidental overwrites.',
    how: 'Every time a policy is edited and published, the previous version is archived with a timestamp and author. You can view any historical version and see exactly what changed.',
    why: 'When a policy-related complaint arises, you need to know what the policy said at the time of the decision. Version history makes this unambiguous.',
    accent: 'from-cyan-600 to-sky-500',
    border: 'border-cyan-200 dark:border-cyan-900/50',
    bg: 'bg-cyan-50 dark:bg-cyan-950/20',
    textAccent: 'text-cyan-600 dark:text-cyan-400',
  },
  {
    icon: Cpu,
    title: 'Policy Simulation',
    tagline: 'Test a new rule against real cases before it goes live — no surprises.',
    how: 'Select a draft policy and run it against a set of historical tickets. The simulator shows what decision each ticket would have received under the new rule, compared to what actually happened.',
    why: 'Policies that look correct on paper often produce edge cases nobody anticipated. Simulation catches those before they affect customers.',
    accent: 'from-sky-600 to-cyan-500',
    border: 'border-sky-200 dark:border-sky-900/50',
    bg: 'bg-sky-50 dark:bg-sky-950/20',
    textAccent: 'text-sky-600 dark:text-sky-400',
  },
  {
    icon: Search,
    title: 'Instant Search',
    tagline: 'Agents find the right SOP in seconds — not after scrolling a handbook.',
    how: 'Type any keyword — issue type, product category, or action — and the matching policy appears immediately. Results are ranked by relevance to the current context.',
    why: "Agents under pressure don't have time to navigate a folder hierarchy. Instant search means the right policy is always one search away.",
    accent: 'from-cyan-600 to-sky-500',
    border: 'border-cyan-200 dark:border-cyan-900/50',
    bg: 'bg-cyan-50 dark:bg-cyan-950/20',
    textAccent: 'text-cyan-600 dark:text-cyan-400',
  },
  {
    icon: Lock,
    title: 'Policy Locking',
    tagline: "Published policies can't be accidentally overwritten. Changes require a new version.",
    how: 'Once a policy is published, it enters a locked state. Any modification creates a draft version that must go through the simulation step before it can replace the current live policy.',
    why: 'The live policy is what Cardinal uses to make decisions. Accidental edits to a live policy could cause incorrect resolutions to go out before anyone notices.',
    accent: 'from-sky-600 to-cyan-500',
    border: 'border-sky-200 dark:border-sky-900/50',
    bg: 'bg-sky-50 dark:bg-sky-950/20',
    textAccent: 'text-sky-600 dark:text-sky-400',
  },
]

function CapabilityCard({ cap, index }: { cap: typeof CAPABILITIES[0]; index: number }) {
  const [open, setOpen] = useState(false)
  const ref = useReveal()

  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${index * 100}ms` }}>
      <button
        onClick={() => setOpen(!open)}
        className={`w-full text-left rounded-2xl border transition-all duration-300 overflow-hidden ${
          open
            ? `${cap.border} ${cap.bg}`
            : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:border-slate-300 dark:hover:border-zinc-700'
        }`}
      >
        <div className="flex items-center gap-5 p-6">
          <div className={`flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br ${cap.accent} flex items-center justify-center shadow-lg`}>
            <cap.icon className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-slate-900 dark:text-white font-semibold text-base mb-1">{cap.title}</div>
            <div className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{cap.tagline}</div>
          </div>
          <ChevronRight className={`w-5 h-5 text-slate-400 dark:text-zinc-500 flex-shrink-0 transition-transform duration-300 ${open ? 'rotate-90' : ''}`} />
        </div>

        <div className={`overflow-hidden transition-all duration-500 ${open ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-6 pb-6 border-t border-slate-100 dark:border-zinc-800 pt-5 space-y-4">
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${cap.textAccent}`}>How it works</div>
              <p className="text-slate-600 dark:text-zinc-300 text-sm leading-relaxed">{cap.how}</p>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-slate-400 dark:text-zinc-500">Why it matters</div>
              <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{cap.why}</p>
            </div>
          </div>
        </div>
      </button>
    </div>
  )
}

// ─── Without vs With toggle ───────────────────────────────────────────────────

const WITHOUT_SCENARIOS = [
  { issue: 'Policy updated in shared Google Doc', outcome: 'Half the team sees old version. Cardinal has no way to know what the current rule is.' },
  { issue: 'New refund threshold tested immediately on live traffic', outcome: 'Edge case discovered after 50 customers get the wrong outcome.' },
  { issue: 'Agent needs to find the cancellation policy', outcome: 'Searches Slack, asks a colleague, finds a doc from 8 months ago.' },
  { issue: 'Audit asks what policy was in effect on a specific date', outcome: 'Nobody knows. Doc history unclear. Best guess.' },
]

const WITH_SCENARIOS = [
  { issue: 'Policy updated in shared Google Doc', outcome: 'New version created in KB. Simulated. Published. Cardinal reads it immediately. Old version archived.' },
  { issue: 'New refund threshold tested immediately on live traffic', outcome: 'Simulated against 200 historical cases first. Edge cases caught. Published with confidence.' },
  { issue: 'Agent needs to find the cancellation policy', outcome: 'Search "cancellation". Current version shown instantly. No ambiguity.' },
  { issue: 'Audit asks what policy was in effect on a specific date', outcome: 'Version history shows exactly which policy was live and when it was published.' },
]

function CompareToggle() {
  const [withKB, setWithKB] = useState(false)
  const scenarios = withKB ? WITH_SCENARIOS : WITHOUT_SCENARIOS

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
      {/* Toggle */}
      <div className="flex border-b border-slate-100 dark:border-zinc-800">
        <button
          onClick={() => setWithKB(false)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            !withKB
              ? 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 border-b-2 border-red-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          Without Knowledge Base
        </button>
        <button
          onClick={() => setWithKB(true)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            withKB
              ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          With Knowledge Base
        </button>
      </div>

      {/* Scenarios */}
      <div className="divide-y divide-slate-100 dark:divide-zinc-800">
        {scenarios.map((s, i) => (
          <div key={i} className="flex items-start gap-4 p-4">
            {!withKB
              ? <XCircle className="w-4 h-4 mt-0.5 text-red-400 flex-shrink-0" />
              : <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
            }
            <div>
              <div className="text-slate-500 dark:text-zinc-400 text-xs mb-1">{s.issue}</div>
              <div className={`text-sm font-medium ${!withKB ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
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

export default function KnowledgeBasePage() {
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
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: dotGrid, backgroundSize: '28px 28px' }}
        />
        <div className="orb-drift absolute -top-32 left-1/4 w-[600px] h-[500px] rounded-full bg-cyan-600/10 dark:bg-cyan-600/12 blur-[120px] pointer-events-none" />
        <div className="orb-drift-2 absolute top-20 right-1/4 w-[400px] h-[400px] rounded-full bg-sky-600/8 dark:bg-sky-600/10 blur-[100px] pointer-events-none" />

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="hero-in-1 inline-flex items-center gap-2 rounded-full border border-cyan-200 dark:border-cyan-900/60 bg-cyan-50 dark:bg-cyan-950/30 px-4 py-1.5 text-xs text-cyan-600 dark:text-cyan-400 font-medium mb-8">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 pulse-slow" />
            Versioned SOPs · Policy simulation · Instant search
          </div>

          <h1 className="hero-in-2 text-5xl md:text-6xl font-bold leading-[1.06] tracking-tight mb-6">
            <span className="text-slate-900 dark:text-white">Knowledge Base:</span>
            <br />
            <span className="bg-gradient-to-r from-cyan-500 via-sky-500 to-cyan-400 bg-clip-text text-transparent">
              SOPs That Stay Current.
            </span>
          </h1>

          <p className="hero-in-3 text-slate-500 dark:text-zinc-400 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            Your operating procedures live in one place — structured, versioned, and searchable. Before any policy goes live,
            you can test it. After it's published, Cardinal uses it exactly as written.
          </p>

          {/* Visual flow */}
          <div className="mt-14 flex items-center justify-center gap-4 flex-wrap">
            <div className="px-5 py-3 rounded-xl border border-slate-300 dark:border-zinc-600 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-sm">
              <div className="font-semibold text-sm text-slate-700 dark:text-zinc-200">Write SOP</div>
              <div className="text-xs text-slate-400 dark:text-zinc-500">structured format</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border-2 border-cyan-500 bg-cyan-50 dark:bg-cyan-950/30 shadow-lg shadow-cyan-500/20">
              <div className="font-semibold text-sm text-cyan-700 dark:text-cyan-300">Test it first</div>
              <div className="text-xs text-cyan-500 dark:text-cyan-400">simulate before publish</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30">
              <div className="font-semibold text-sm text-emerald-700 dark:text-emerald-300">Go live with confidence</div>
              <div className="text-xs text-emerald-500 dark:text-emerald-400">Cardinal uses it instantly</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Write. Test. Publish. ─────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-5xl">
          <RevealSection className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200 dark:border-cyan-900/60 bg-cyan-50 dark:bg-cyan-950/30 px-4 py-1.5 text-xs text-cyan-600 dark:text-cyan-400 font-medium mb-4">
              How it works
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              Write. Test. Publish.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Three steps — and your policy is live inside Cardinal. Hover each step.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <WorkflowStepper />
          </RevealSection>
        </div>
      </section>

      {/* ── Key capabilities ──────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-cyan-600/3 dark:bg-cyan-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-4xl relative">
          <RevealSection className="text-center mb-14">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 font-medium mb-4">
              Capabilities
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What the Knowledge Base does
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Click any capability to see how it works.
            </p>
          </RevealSection>
          <div className="space-y-4">
            {CAPABILITIES.map((cap, i) => (
              <CapabilityCard key={cap.title} cap={cap} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Compare toggle ────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-sky-600/3 dark:bg-sky-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-3xl relative">
          <RevealSection className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              The same policy change.<br />
              <span className="bg-gradient-to-r from-cyan-500 to-sky-500 bg-clip-text text-transparent">
                A very different outcome.
              </span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Toggle to see what happens with and without the Knowledge Base.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <CompareToggle />
          </RevealSection>
        </div>
      </section>

      {/* ── What it protects ──────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What the Knowledge Base protects
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Structured policies and version control keep every decision traceable and every change safe.
            </p>
          </RevealSection>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                icon: Zap,
                title: 'Decision consistency',
                desc: 'Cardinal always reads the current approved policy — the same rule applies to every matching ticket.',
                accent: 'text-cyan-500',
              },
              {
                icon: Shield,
                title: 'Change safety',
                desc: 'Every new policy is tested before it goes live. No untested rules reach customers.',
                accent: 'text-sky-500',
              },
              {
                icon: Clock,
                title: 'Audit readiness',
                desc: 'Full history of every policy version, who published it, and when it was active.',
                accent: 'text-cyan-500',
              },
              {
                icon: Search,
                title: 'Agent confidence',
                desc: "The right answer is always findable. Agents don't guess — they search.",
                accent: 'text-sky-500',
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
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-cyan-600/5 dark:bg-cyan-600/8 blur-[100px]" />
        </div>
        <RevealSection className="mx-auto max-w-3xl text-center relative">
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
            Your policies deserve better than a shared doc.
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-10">
            The Knowledge Base ships with every Auralis deployment. Your SOPs are live inside Cardinal from day one.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button
              onClick={() => navigate('/signup')}
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-gradient-to-r from-cyan-600 to-sky-600 hover:from-cyan-500 hover:to-sky-500 text-white font-semibold text-sm transition-all shadow-xl shadow-cyan-600/25 hover:shadow-cyan-600/40 hover:-translate-y-0.5"
            >
              Get Started Free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <button
              onClick={() => navigate('/how-it-works')}
              className="px-10 py-4 rounded-xl border border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-500 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white font-medium text-sm transition-all hover:-translate-y-0.5"
            >
              See the full Cardinal pipeline
            </button>
          </div>
        </RevealSection>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer className="border-t border-slate-100 dark:border-zinc-900 py-8 px-6">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-400 dark:text-zinc-500 text-sm">
            <div className="flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-cyan-600 to-sky-600">
              <BookOpen className="w-3 h-3 text-white" />
            </div>
            Auralis · orgsense.in
          </div>
          <div className="text-slate-300 dark:text-zinc-600 text-sm">© 2026 Auralis. All rights reserved.</div>
        </div>
      </footer>
    </div>
  )
}
