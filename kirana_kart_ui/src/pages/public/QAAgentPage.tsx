import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ClipboardCheck, TrendingUp, Users, Shield,
  ChevronRight, CheckCircle2, XCircle, ArrowRight, Sun, Moon, Zap,
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
            className="text-white text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-orange-600 to-amber-500 hover:from-orange-500 hover:to-amber-400 transition-all shadow-lg shadow-orange-600/20">
            Sign Up
          </button>
        </div>
      </div>
    </nav>
  )
}

// ─── Scoring Accordion ────────────────────────────────────────────────────────

const PARAMETERS = [
  {
    title: 'Greeting & Opening Tone',
    summary: 'Did the agent open the conversation appropriately for the context?',
    detail: 'The agent should acknowledge the customer by name if available, use a professional but warm tone, and avoid generic copy-paste openers that feel impersonal.',
  },
  {
    title: 'Issue Identification',
    summary: "Did the agent correctly identify and confirm the customer's core issue?",
    detail: 'Correctly identifying the problem before jumping to a solution is critical. This parameter checks whether the agent restated or confirmed the issue before proceeding.',
  },
  {
    title: 'Policy Adherence',
    summary: 'Was the resolution consistent with the applicable policy?',
    detail: 'Every resolution is compared against the policy that applied at the time of the interaction. Deviations — intentional or not — are flagged.',
  },
  {
    title: 'Empathy Markers',
    summary: "Did the agent acknowledge the customer's frustration or situation?",
    detail: "Empathy doesn't mean agreement. It means the agent recognised that the customer is frustrated and responded with care before moving to the resolution.",
  },
  {
    title: 'Resolution Accuracy',
    summary: 'Was the outcome correct for the issue type?',
    detail: 'The most important parameter. The action taken — refund, replacement, escalation, information — is checked against what the policy and classification require for this ticket type.',
  },
  {
    title: 'Communication Clarity',
    summary: 'Was the response clear, concise, and free of jargon?',
    detail: "Customers shouldn't need to re-read a reply three times. This parameter scores whether the message was direct and easy to understand.",
  },
  {
    title: 'First-Contact Resolution',
    summary: 'Was the issue resolved without the customer needing to follow up?',
    detail: 'Follow-ups are expensive and signal an incomplete first response. This parameter flags cases where the resolution required a second or third interaction.',
  },
  {
    title: 'Escalation Handling',
    summary: 'If the case was escalated, was it done correctly and promptly?',
    detail: "Not every case should be resolved at the first level. This parameter checks whether escalations were justified, well-documented, and handed off to the right team.",
  },
  {
    title: 'Follow-Up Completeness',
    summary: 'If follow-up was promised, did it happen?',
    detail: '"I\'ll check on this and get back to you" is a commitment. This parameter checks whether commitments were fulfilled within the stated timeframe.',
  },
  {
    title: 'Closing Protocol',
    summary: 'Was the conversation closed professionally with a CSAT or summary?',
    detail: 'A proper close includes a summary of what was done, any reference numbers, and — where applicable — a satisfaction check. Abrupt closures are flagged.',
  },
]

function ScoringAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <div className="space-y-3">
      {PARAMETERS.map((param, i) => {
        const isOpen = openIndex === i
        return (
          <div
            key={param.title}
            className={`rounded-2xl border transition-all duration-300 overflow-hidden ${
              isOpen
                ? 'border-orange-200 dark:border-orange-900/50 bg-orange-50/50 dark:bg-orange-950/10'
                : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:border-slate-300 dark:hover:border-zinc-700'
            }`}
          >
            <button
              onClick={() => setOpenIndex(isOpen ? null : i)}
              className="w-full text-left flex items-center gap-4 px-6 py-5"
            >
              <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                isOpen
                  ? 'bg-orange-500 text-white'
                  : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400'
              }`}>
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-slate-900 dark:text-white font-semibold text-base">{param.title}</div>
                <div className="text-slate-500 dark:text-zinc-400 text-sm mt-0.5 leading-relaxed">{param.summary}</div>
              </div>
              <ChevronRight className={`w-5 h-5 text-slate-400 dark:text-zinc-500 flex-shrink-0 transition-transform duration-300 ${isOpen ? 'rotate-90' : ''}`} />
            </button>

            <div className={`overflow-hidden transition-all duration-500 ${isOpen ? 'max-h-48 opacity-100' : 'max-h-0 opacity-0'}`}>
              <div className="px-6 pb-5 border-t border-slate-100 dark:border-zinc-800 pt-4">
                <p className="text-slate-600 dark:text-zinc-300 text-sm leading-relaxed">{param.detail}</p>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Compare Toggle ───────────────────────────────────────────────────────────

const WITHOUT_SCENARIOS = [
  { issue: '10% of conversations reviewed manually', outcome: 'The other 90% go unscored — including the worst ones, which nobody selected.' },
  { issue: 'Reviewing takes 15 minutes per conversation', outcome: 'At scale, manual QA is a full-time job. Usually a part-time one.' },
  { issue: 'Different reviewers apply different standards', outcome: 'Score variance between reviewers makes coaching unreliable.' },
  { issue: 'Issues surface weeks after they happen', outcome: 'The agent has already handled 200 more conversations the same wrong way.' },
]

const WITH_SCENARIOS = [
  { issue: 'Every conversation reviewed automatically', outcome: 'No conversation goes unscored. The worst cases are found immediately.' },
  { issue: 'Scores calculated in seconds after each interaction', outcome: 'QA keeps pace with volume — however busy it gets.' },
  { issue: 'Same 10 parameters applied every time', outcome: 'No reviewer variance. Every agent measured by the same standard.' },
  { issue: 'Issues surface same day', outcome: 'Coaching happens while the pattern is still fresh — not weeks later.' },
]

function CompareToggle() {
  const [withQA, setWithQA] = useState(false)
  const scenarios = withQA ? WITH_SCENARIOS : WITHOUT_SCENARIOS

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
      {/* Toggle */}
      <div className="flex border-b border-slate-100 dark:border-zinc-800">
        <button
          onClick={() => setWithQA(false)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            !withQA
              ? 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 border-b-2 border-red-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          Manual QA (10% sample)
        </button>
        <button
          onClick={() => setWithQA(true)}
          className={`flex-1 py-3.5 text-sm font-medium transition-all ${
            withQA
              ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-400'
              : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
          }`}
        >
          With QA Agent (100%)
        </button>
      </div>

      {/* Scenarios */}
      <div className="divide-y divide-slate-100 dark:divide-zinc-800">
        {scenarios.map((s, i) => (
          <div key={i} className="flex items-start gap-4 p-4">
            {!withQA
              ? <XCircle className="w-4 h-4 mt-0.5 text-red-400 flex-shrink-0" />
              : <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
            }
            <div>
              <div className="text-slate-500 dark:text-zinc-400 text-xs mb-1">{s.issue}</div>
              <div className={`text-sm font-medium ${!withQA ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
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

export default function QAAgentPage() {
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
        <div className="orb-drift absolute -top-32 left-1/4 w-[600px] h-[500px] rounded-full bg-orange-600/10 dark:bg-orange-600/12 blur-[120px] pointer-events-none" />
        <div className="orb-drift-2 absolute top-20 right-1/4 w-[400px] h-[400px] rounded-full bg-amber-600/8 dark:bg-amber-600/10 blur-[100px] pointer-events-none" />

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="hero-in-1 inline-flex items-center gap-2 rounded-full border border-orange-200 dark:border-orange-900/60 bg-orange-50 dark:bg-orange-950/30 px-4 py-1.5 text-xs text-orange-600 dark:text-orange-400 font-medium mb-8">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400 pulse-slow" />
            Full coverage · Consistent scoring · No manual review
          </div>

          <h1 className="hero-in-2 text-5xl md:text-6xl font-bold leading-[1.06] tracking-tight mb-6">
            <span className="text-slate-900 dark:text-white">QA Agent:</span>
            <br />
            <span className="bg-gradient-to-r from-orange-500 via-amber-500 to-orange-400 bg-clip-text text-transparent">
              Every Conversation, Graded.
            </span>
          </h1>

          <p className="hero-in-3 text-slate-500 dark:text-zinc-400 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
            Your QA Agent reviews every interaction your support agents have — automatically, consistently, against the same set of criteria. Not a sample. Not a spot-check. All of them.
          </p>

          {/* Visual: conversation → QA Agent → score */}
          <div className="mt-14 flex items-center justify-center gap-4 flex-wrap">
            <div className="px-5 py-3 rounded-xl border border-slate-300 dark:border-zinc-600 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-sm">
              <div className="font-semibold text-sm text-slate-600 dark:text-zinc-300">Agent conversation</div>
              <div className="text-xs text-slate-400 dark:text-zinc-500">any channel</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border-2 border-orange-500 bg-orange-50 dark:bg-orange-950/30 shadow-lg shadow-orange-500/20">
              <div className="font-semibold text-sm text-orange-700 dark:text-orange-300">QA Agent</div>
              <div className="text-xs text-orange-500 dark:text-orange-400">reviews everything</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
            <div className="px-5 py-3 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30">
              <div className="font-semibold text-sm text-emerald-700 dark:text-emerald-300">Score + feedback</div>
              <div className="text-xs text-emerald-500 dark:text-emerald-400">logged automatically</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Scoring Framework ─────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-orange-600/3 dark:bg-orange-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-4xl relative">
          <RevealSection className="text-center mb-14">
            <div className="inline-flex items-center gap-2 rounded-full border border-orange-200 dark:border-orange-900/60 bg-orange-50 dark:bg-orange-950/30 px-4 py-1.5 text-xs text-orange-600 dark:text-orange-400 font-medium mb-4">
              The scoring rubric
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What gets scored?
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Ten parameters. Applied consistently to every conversation — no variation between reviewers.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <ScoringAccordion />
          </RevealSection>
        </div>
      </section>

      {/* ── Sampling vs Full Coverage ─────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-amber-600/3 dark:bg-amber-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-3xl relative">
          <RevealSection className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              Sampling vs. full coverage.<br />
              <span className="bg-gradient-to-r from-orange-500 to-amber-500 bg-clip-text text-transparent">
                The difference isn't subtle.
              </span>
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Toggle to see what happens when QA depends on sampling versus when every conversation is reviewed.
            </p>
          </RevealSection>
          <RevealSection delay={150}>
            <CompareToggle />
          </RevealSection>
        </div>
      </section>

      {/* ── What you get ─────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
              What the QA Agent gives you
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              Consistent coverage, actionable insight, and a permanent record — without building a QA team to match your support volume.
            </p>
          </RevealSection>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                icon: ClipboardCheck,
                title: 'Consistent scoring',
                desc: 'The same 10-parameter rubric applied to every conversation — no reviewer bias, no variation by shift.',
                accent: 'text-orange-500',
              },
              {
                icon: TrendingUp,
                title: 'Trend visibility',
                desc: 'Track which parameters are improving or declining week-over-week across your team.',
                accent: 'text-amber-500',
              },
              {
                icon: Users,
                title: 'Agent-level insights',
                desc: 'See each agent\'s score profile — where they excel, where they need support.',
                accent: 'text-orange-500',
              },
              {
                icon: Shield,
                title: 'Audit readiness',
                desc: 'Every score is stored with the conversation and the scoring rationale. Nothing is inferred or summarised.',
                accent: 'text-amber-500',
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
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-orange-600/5 dark:bg-orange-600/8 blur-[100px]" />
        </div>
        <RevealSection className="mx-auto max-w-3xl text-center relative">
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
            Stop sampling. Start knowing.
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-10">
            The QA Agent scores every conversation automatically — no configuration, no reviewer schedules, no gaps.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button onClick={() => navigate('/signup')}
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-semibold text-sm transition-all shadow-xl shadow-orange-600/25 hover:shadow-orange-600/40 hover:-translate-y-0.5">
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
            <div className="flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-orange-600 to-amber-600">
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
