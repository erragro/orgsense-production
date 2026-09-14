import { Link } from 'react-router-dom'
import { ArrowRight, ShieldCheck, Target, Workflow } from 'lucide-react'

export function PolicyValueIntro() {
  return <section aria-label="From policy intent to business decisions" className="rounded-2xl border border-brand-500/30 bg-surface-card p-5 sm:p-7 mb-8">
    <p className="text-xs uppercase tracking-widest font-semibold text-brand-600 dark:text-brand-400">From intent to impact</p>
    <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-2 max-w-2xl">Turn your SOP into decisions you can explain—and test before going live.</h2>
    <p className="text-sm text-foreground/75 leading-relaxed mt-3 max-w-2xl">Bring your operating knowledge. Review how it becomes customer decisions. Compare the proposal with today’s policy, then make an informed launch decision.</p>
    <div className="grid sm:grid-cols-3 gap-4 mt-6">
      {[
        { icon: Target, title: 'Control compensation', text: 'Make eligibility, limits and exceptions explicit.' },
        { icon: Workflow, title: 'Resolve consistently', text: 'Give the same situation a clear, repeatable response.' },
        { icon: ShieldCheck, title: 'Change with evidence', text: 'Inspect differences before committing to a new policy.' },
      ].map(({ icon: Icon, title, text }) => <div key={title} className="rounded-xl bg-surface-card/80 border border-surface-border p-4"><Icon className="w-5 h-5 text-brand-600 mb-3" /><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-foreground/75 leading-relaxed mt-1">{text}</p></div>)}
    </div>
    <details className="mt-5 text-sm">
      <summary className="cursor-pointer font-medium">How customer problems, decisions and tests connect</summary>
      <div className="mt-3 space-y-3 text-foreground/75 leading-relaxed">
        <p><strong className="text-foreground">Illustrative example:</strong> a customer reports a missing item → check eligibility and the refund limit → refund or refer for review. Your SOP defines the actual conditions.</p>
        <p><strong className="text-foreground">Sample replay:</strong> compare decisions on saved test cases. <strong className="text-foreground">Live comparison:</strong> observe recommendations alongside the current policy, with no customer action from the comparison itself. <strong className="text-foreground">Activation:</strong> change which policy governs new tickets.</p>
        <p>Intended benefits are goals, not measured savings. Each test shows what it covers and what remains unknown.</p>
      </div>
    </details>
    <div className="flex flex-wrap gap-5 mt-5 text-sm font-medium">
      <Link className="inline-flex items-center gap-1 text-brand-600" to="/policy?view=simulation">Explore a case <ArrowRight className="w-4 h-4" /></Link>
      <Link className="inline-flex items-center gap-1 text-brand-600" to="/policy?view=shadow">Review live comparison <ArrowRight className="w-4 h-4" /></Link>
      <Link className="inline-flex items-center gap-1 text-brand-600" to="/taxonomy">Browse customer problems <ArrowRight className="w-4 h-4" /></Link>
    </div>
  </section>
}
