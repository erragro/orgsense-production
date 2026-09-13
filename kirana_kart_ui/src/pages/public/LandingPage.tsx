import { useEffect, useRef, useState, forwardRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Cpu, ShieldCheck, BarChart3, ClipboardCheck, LifeBuoy, BookOpen,
  ArrowRight, Zap, Sun, Moon, CheckCircle2, XCircle,
  Inbox, BrainCircuit, Send,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { useUIStore } from '@/stores/ui.store'

// ─── Animation styles ────────────────────────────────────────────────────────

const ANIMATION_CSS = `
  @keyframes float-a {
    0%, 100% { transform: translateY(0px) rotate(0deg); }
    50% { transform: translateY(-14px) rotate(1deg); }
  }
  @keyframes float-b {
    0%, 100% { transform: translateY(0px) rotate(0deg); }
    50% { transform: translateY(-10px) rotate(-1deg); }
  }
  @keyframes float-c {
    0%, 100% { transform: translateY(0px); }
    50% { transform: translateY(-18px); }
  }
  @keyframes shimmer {
    0% { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(28px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes orb-drift {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33% { transform: translate(30px, -20px) scale(1.05); }
    66% { transform: translate(-20px, 15px) scale(0.97); }
  }
  .orb-drift { animation: orb-drift 18s ease-in-out infinite; }
  .orb-drift-2 { animation: orb-drift 22s ease-in-out infinite reverse 4s; }
  .hero-text-1 { animation: fade-up 0.7s ease forwards; }
  .hero-text-2 { animation: fade-up 0.7s ease forwards 0.15s; opacity: 0; }
  .hero-text-3 { animation: fade-up 0.7s ease forwards 0.3s; opacity: 0; }
  .hero-text-4 { animation: fade-up 0.7s ease forwards 0.45s; opacity: 0; }
  .reveal {
    opacity: 0;
    transform: translateY(24px);
    transition: opacity 0.55s ease, transform 0.55s ease;
  }
  .reveal.visible {
    opacity: 1;
    transform: translateY(0);
  }
  .shimmer-text {
    background: linear-gradient(
      90deg,
      currentColor 0%,
      currentColor 35%,
      rgba(147,51,234,0.9) 50%,
      currentColor 65%,
      currentColor 100%
    );
    background-size: 200% auto;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
`

// ─── Navbar ──────────────────────────────────────────────────────────────────

function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const navigate = useNavigate()
  const { theme, toggleTheme } = useUIStore()

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled
        ? 'bg-white/90 dark:bg-zinc-950/90 backdrop-blur-md border-b border-slate-200/60 dark:border-zinc-800/60'
        : 'bg-transparent'
    }`}>
      <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-lg shadow-blue-600/30">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="text-slate-900 dark:text-white font-bold text-lg leading-none">Auralis</span>
            <span className="block text-slate-400 dark:text-zinc-500 text-xs leading-none">orgsense.in</span>
          </div>
        </div>
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
            className="p-2 rounded-lg border border-slate-200 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:border-slate-300 dark:hover:border-zinc-500 transition-all"
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

// ─── Floating badge ───────────────────────────────────────────────────────────

const FloatingBadge = forwardRef<HTMLDivElement, {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  className?: string
  accent: string
}>(function FloatingBadge({ icon: Icon, label, value, className, accent }, ref) {
  return (
    <div
      ref={ref}
      className={`${className} absolute hidden lg:flex items-center gap-2.5 rounded-2xl border bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm px-4 py-3 shadow-xl shadow-black/10 dark:shadow-black/40 border-slate-200/80 dark:border-zinc-700/60 will-change-transform`}
    >
      <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${accent} flex items-center justify-center flex-shrink-0`}>
        <Icon className="w-4 h-4 text-white" />
      </div>
      <div>
        <p className="text-slate-900 dark:text-white text-sm font-bold leading-tight">{value}</p>
        <p className="text-slate-400 dark:text-zinc-500 text-xs leading-tight">{label}</p>
      </div>
    </div>
  )
})

// ─── Capability card ──────────────────────────────────────────────────────────

function CapabilityCard({
  icon: Icon, title, description, accent, index, href,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  accent: string
  index: number
  href?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) el.classList.add('visible') },
      { threshold: 0.15 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      onClick={href ? () => navigate(href) : undefined}
      className={`reveal group rounded-2xl bg-white dark:bg-zinc-900/80 border border-slate-200 dark:border-zinc-800 p-6 hover:border-blue-300/60 dark:hover:border-zinc-600 hover:shadow-xl hover:shadow-blue-500/5 dark:hover:shadow-black/30 transition-all duration-300 ${href ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ transitionDelay: `${index * 80}ms` }}
    >
      <div className={`inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${accent} mb-4 shadow-lg group-hover:scale-110 transition-transform duration-300`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
      <h3 className="text-slate-900 dark:text-white font-semibold text-base mb-2">
        {title}
        {href && <ArrowRight className="inline w-3.5 h-3.5 ml-1.5 opacity-0 group-hover:opacity-60 group-hover:translate-x-0.5 transition-all duration-200" />}
      </h3>
      <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{description}</p>
    </div>
  )
}

// ─── Reveal section wrapper ───────────────────────────────────────────────────

function RevealSection({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) el.classList.add('visible') },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} className={`reveal ${className}`}>{children}</div>
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const { theme } = useUIStore()

  const orb1Ref   = useRef<HTMLDivElement>(null)
  const orb2Ref   = useRef<HTMLDivElement>(null)
  const badge1Ref = useRef<HTMLDivElement>(null)
  const badge2Ref = useRef<HTMLDivElement>(null)
  const badge3Ref = useRef<HTMLDivElement>(null)
  const badge4Ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true })
  }, [user, navigate])

  // Parallax on scroll — direct DOM, no re-render
  useEffect(() => {
    const handler = () => {
      const y = window.scrollY
      if (orb1Ref.current)   orb1Ref.current.style.transform   = `translateY(${y * 0.18}px)`
      if (orb2Ref.current)   orb2Ref.current.style.transform   = `translateY(${y * -0.12}px)`
      // Each badge has its own rate — no CSS animation conflict
      if (badge1Ref.current) badge1Ref.current.style.transform = `translateY(${y * -0.07}px)`
      if (badge2Ref.current) badge2Ref.current.style.transform = `translateY(${y * -0.11}px)`
      if (badge3Ref.current) badge3Ref.current.style.transform = `translateY(${y * -0.05}px)`
      if (badge4Ref.current) badge4Ref.current.style.transform = `translateY(${y * -0.09}px)`
    }
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  const capabilities = [
    { icon: Cpu,           title: 'Cardinal Pipeline',  description: 'Every complaint gets the same expert treatment — identified, evaluated against your policies, and resolved. Automatically, every time.', accent: 'from-blue-600 to-blue-500',    href: '/how-it-works' },
    { icon: ShieldCheck,   title: 'L2 Validator',       description: 'Spots duplicate complaints and conflicting rules before they waste your team\'s time. A quality gate that never blinks.',             accent: 'from-violet-600 to-violet-500', href: '/l2-validator' },
    { icon: BarChart3,     title: 'BI Agent',            description: 'Ask "How many refunds did we issue yesterday?" and get a chart. No spreadsheets, no data team, no waiting.',                        accent: 'from-emerald-600 to-teal-500',  href: '/bi-intelligence' },
    { icon: ClipboardCheck,title: 'QA Agent',            description: 'Every agent conversation is graded automatically. Not 10% of them — all of them, all the time.',                                   accent: 'from-orange-600 to-amber-500',  href: '/quality-assurance' },
    { icon: LifeBuoy,      title: 'CRM & Ticket Ops',   description: 'Track every open case, automate follow-ups, and never miss a deadline. Your ops team\'s command centre.',                            accent: 'from-rose-600 to-pink-500',     href: '/ticket-ops' },
    { icon: BookOpen,      title: 'Knowledge Base',      description: 'Keep your SOPs alive and searchable. Test a policy change in simulation before it goes live — no surprises.',                       accent: 'from-cyan-600 to-sky-500',      href: '/knowledge-ops' },
  ]

  const dotGrid = theme === 'dark'
    ? 'radial-gradient(circle, rgba(255,255,255,0.055) 1px, transparent 1px)'
    : 'radial-gradient(circle, rgba(0,0,0,0.055) 1px, transparent 1px)'

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-slate-900 dark:text-white overflow-x-hidden">
      <style>{ANIMATION_CSS}</style>
      <Navbar />

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex items-center pt-20 pb-16 px-6 overflow-hidden">

        {/* Dot grid background */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: dotGrid, backgroundSize: '28px 28px' }} />

        {/* Gradient orbs — parallax */}
        <div ref={orb1Ref} className="orb-drift absolute -top-32 left-1/4 w-[700px] h-[600px] rounded-full bg-blue-600/10 dark:bg-blue-600/12 blur-[120px] pointer-events-none" />
        <div ref={orb2Ref} className="orb-drift-2 absolute top-20 right-1/4 w-[500px] h-[500px] rounded-full bg-violet-600/8 dark:bg-violet-600/10 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[200px] bg-gradient-to-t from-white dark:from-zinc-950 to-transparent pointer-events-none" />

        <div className="relative mx-auto max-w-5xl w-full">
          <div className="text-center">
            {/* Live badge */}
            <div className="hero-text-1 inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/80 backdrop-blur-sm px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 mb-8">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live at orgsense.in
            </div>

            {/* Headline */}
            <h1 className="hero-text-2 text-5xl md:text-7xl font-bold leading-[1.05] tracking-tight mb-6">
              <span className="text-slate-900 dark:text-white">The Operating System</span>
              <br />
              <span className="text-slate-900 dark:text-white">for </span>
              <span className="bg-gradient-to-r from-blue-500 via-violet-500 to-blue-400 bg-clip-text text-transparent">
                CX Teams
              </span>
            </h1>

            <p className="hero-text-3 text-slate-500 dark:text-zinc-400 text-lg md:text-xl max-w-2xl mx-auto mb-10 leading-relaxed">
              Every customer complaint. Every channel. One platform that handles it all —
              consistently, at scale, without the manual overhead.
            </p>

            {/* CTAs */}
            <div className="hero-text-4 flex items-center justify-center gap-4 flex-wrap">
              <button onClick={() => navigate('/signup')}
                className="group flex items-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-semibold text-sm transition-all shadow-xl shadow-blue-600/25 hover:shadow-blue-600/40 hover:-translate-y-0.5">
                Get Started
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>
              <button onClick={() => navigate('/login')}
                className="px-8 py-4 rounded-xl border border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-500 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white font-medium text-sm transition-all hover:-translate-y-0.5">
                Log In
              </button>
            </div>

            {/* Tagline */}
            <div className="mt-10 inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/50 px-5 py-2 text-sm text-slate-400 dark:text-zinc-500">
              AI-powered · End-to-end CX automation · Enterprise-grade
            </div>
          </div>

          {/* Floating accent badges — each has its own ref + independent scroll rate */}
          <FloatingBadge ref={badge1Ref} icon={Cpu}           value="5-Phase"       label="Cardinal Pipeline"     accent="from-blue-600 to-blue-500"     className="left-0 top-[28%]" />
          <FloatingBadge ref={badge2Ref} icon={BarChart3}     value="Plain English" label="BI Queries"            accent="from-emerald-600 to-teal-500"  className="right-0 top-[22%]" />
          <FloatingBadge ref={badge3Ref} icon={ClipboardCheck} value="10-Param"     label="QA Scoring"           accent="from-orange-600 to-amber-500"  className="left-4 bottom-[18%]" />
          <FloatingBadge ref={badge4Ref} icon={ShieldCheck}   value="100%"          label="Interactions Audited" accent="from-violet-600 to-violet-500"  className="right-4 bottom-[12%]" />
        </div>
      </section>

      {/* ── 3 Steps ─────────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-slate-100 dark:border-zinc-900">
        <div className="mx-auto max-w-6xl">
          <RevealSection className="text-center mb-16">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 px-4 py-1.5 text-xs text-blue-600 dark:text-blue-400 font-medium mb-4">
              How It Works
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              From complaint to resolution — fully automated.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-lg mx-auto">
              One platform. Every channel. Every decision handled.
            </p>
          </RevealSection>

          <div className="relative grid md:grid-cols-3 gap-6 md:gap-0">
            {/* Dashed connector line on desktop */}
            <div className="hidden md:block absolute top-10 left-[calc(33%+1rem)] right-[calc(33%+1rem)] border-t-2 border-dashed border-slate-200 dark:border-zinc-800 z-0" />

            {[
              {
                icon: Inbox,
                step: '①',
                title: 'A complaint arrives',
                desc: 'A customer reaches out — email, chat, form, wherever. Cardinal picks it up immediately, regardless of channel.',
                accent: 'from-blue-600 to-blue-500',
                delay: 0,
              },
              {
                icon: BrainCircuit,
                step: '②',
                title: 'Cardinal decides what to do',
                desc: 'It reads the complaint, matches the issue, checks your policies, and picks the right action — in seconds.',
                accent: 'from-violet-600 to-violet-500',
                delay: 120,
              },
              {
                icon: Send,
                step: '③',
                title: 'Resolution goes out',
                desc: 'The decision is executed. Your team sees the full audit trail. The customer gets a fast, consistent answer.',
                accent: 'from-emerald-600 to-teal-500',
                delay: 240,
              },
            ].map((item) => (
              <RevealSection key={item.title} className="relative z-10 md:px-8 first:pl-0 last:pr-0">
                <div className="flex flex-col items-center text-center">
                  <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${item.accent} flex items-center justify-center mb-5 shadow-xl`}>
                    <item.icon className="w-9 h-9 text-white" />
                  </div>
                  <div className="text-3xl font-bold text-slate-200 dark:text-zinc-700 mb-2">{item.step}</div>
                  <h3 className="text-slate-900 dark:text-white font-semibold text-lg mb-3">{item.title}</h3>
                  <p className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed max-w-xs">{item.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>

          <RevealSection className="text-center mt-12">
            <button onClick={() => navigate('/how-it-works')}
              className="inline-flex items-center gap-2 text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 text-sm font-medium transition-colors group">
              See how Cardinal works in detail
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
          </RevealSection>
        </div>
      </section>

      {/* ── Feature strip ────────────────────────────────────────────────────── */}
      <section className="py-0">
        <div className="bg-slate-950 dark:bg-zinc-900/60 border-y border-slate-800 dark:border-zinc-800">
          <div className="mx-auto max-w-5xl grid grid-cols-2 md:grid-cols-4 divide-x divide-slate-800 dark:divide-zinc-800">
            {[
              { value: 'Any source', label: 'Email · Chat · Forms · API · Voice' },
              { value: 'Policy-exact', label: 'Every decision follows your defined rules' },
              { value: 'Fully audited', label: 'Every interaction logged — nothing skipped' },
              { value: 'Always on', label: 'Cardinal runs 24/7, no manual intervention' },
            ].map((item) => (
              <div key={item.value} className="px-8 py-8 text-center">
                <div className="text-lg md:text-xl font-bold text-white mb-1">{item.value}</div>
                <div className="text-slate-400 text-xs leading-snug">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Capabilities ────────────────────────────────────────────────────── */}
      <section className="py-28 px-6 relative">
        <div className="mx-auto max-w-7xl">
          <RevealSection className="text-center mb-16">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 px-4 py-1.5 text-xs text-blue-600 dark:text-blue-400 font-medium mb-4">
              Platform Modules
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              Six modules. One decision engine.
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-base max-w-xl mx-auto">
              Each layer feeds the next — from raw signal to resolved outcome.
            </p>
          </RevealSection>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {capabilities.map((cap, i) => (
              <CapabilityCard key={cap.title} {...cap} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Problem / Solution ───────────────────────────────────────────────── */}
      <section className="py-28 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        {/* subtle bg accent */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] rounded-full bg-violet-600/3 dark:bg-violet-600/5 blur-[120px]" />
        </div>
        <div className="mx-auto max-w-6xl grid md:grid-cols-2 gap-16 items-start relative">
          <RevealSection>
            <div className="inline-flex items-center gap-2 rounded-full border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 px-3 py-1 text-xs text-red-600 dark:text-red-400 font-medium mb-6">
              The Problem
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white mb-8 leading-tight">
              Scaling CX without automation creates compounding complexity
            </h2>
            <ul className="space-y-4">
              {[
                'Agents making inconsistent decisions on identical complaints',
                'No audit trail — quality scoring is manual and sampled',
                'Knowledge bases go stale the moment a policy changes',
                'BI requires a data analyst just to answer "how many P1s today?"',
                'SLA breaches invisible until the customer escalates',
              ].map((item) => (
                <li key={item} className="flex items-start gap-3 group">
                  <XCircle className="w-4 h-4 mt-0.5 text-red-400 dark:text-red-500 flex-shrink-0" />
                  <span className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </RevealSection>

          <RevealSection className="[transition-delay:150ms]">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium mb-6">
              The Solution
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white mb-8 leading-tight">
              Auralis replaces judgment calls with a decision engine
            </h2>
            <ul className="space-y-4">
              {[
                'Cardinal routes every ticket through 5 deterministic phases',
                'QA Agent scores 100% of interactions — no sampling',
                'Knowledge Base versioning with policy simulation before rollout',
                'BI Agent answers ops questions in plain English, instantly',
                'Real-time SLA visibility with automated escalation triggers',
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
                  <span className="text-slate-500 dark:text-zinc-400 text-sm leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </RevealSection>
        </div>
      </section>

      {/* ── Team teaser ──────────────────────────────────────────────────────── */}
      <section className="py-28 px-6 border-t border-slate-100 dark:border-zinc-900">
        <RevealSection className="mx-auto max-w-3xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-1.5 text-xs text-slate-500 dark:text-zinc-400 font-medium mb-6">
            The Team
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white mb-4">
            Built by operators, not observers
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-12 max-w-xl mx-auto">
            The team behind Auralis spent years leading CX operations at scale before
            building the platform they wished existed.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-10">
            {[
              { initials: 'SC', name: 'Surajit Chaudhuri', role: 'Chief Creator', gradient: 'from-blue-700 to-violet-700' },
              { initials: 'RR', name: 'Renzil Rodrigues',  role: 'AI Full Stack Developer', gradient: 'from-emerald-700 to-teal-700' },
            ].map(({ initials, name, role, gradient }) => (
              <div key={initials}
                className="flex items-center gap-3 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl px-5 py-4 hover:shadow-lg hover:shadow-black/5 dark:hover:shadow-black/30 hover:-translate-y-1 transition-all duration-300 cursor-default">
                <div className={`w-11 h-11 rounded-full bg-gradient-to-br ${gradient} flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-md`}>
                  {initials}
                </div>
                <div className="text-left">
                  <div className="text-slate-900 dark:text-white text-sm font-semibold">{name}</div>
                  <div className="text-slate-400 dark:text-zinc-500 text-xs">{role}</div>
                </div>
              </div>
            ))}
          </div>
          <button onClick={() => navigate('/team')}
            className="inline-flex items-center gap-2 text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 text-sm font-medium transition-colors group">
            Meet the Team
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>
        </RevealSection>
      </section>

      {/* ── Footer CTA ───────────────────────────────────────────────────────── */}
      <section className="py-28 px-6 border-t border-slate-100 dark:border-zinc-900 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-blue-600/5 dark:bg-blue-600/8 blur-[100px]" />
        </div>
        <RevealSection className="mx-auto max-w-3xl text-center relative">
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
            Ready to transform your CX operations?
          </h2>
          <p className="text-slate-500 dark:text-zinc-400 text-base mb-10">
            Join teams already using Auralis to automate decisions at scale.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <button onClick={() => navigate('/signup')}
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-semibold text-sm transition-all shadow-xl shadow-blue-600/25 hover:shadow-blue-600/40 hover:-translate-y-0.5">
              Sign Up Free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <button onClick={() => navigate('/login')}
              className="px-10 py-4 rounded-xl border border-slate-300 dark:border-zinc-700 hover:border-slate-400 dark:hover:border-zinc-500 text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white font-medium text-sm transition-all hover:-translate-y-0.5">
              Log In
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
