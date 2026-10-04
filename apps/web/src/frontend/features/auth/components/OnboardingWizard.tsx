import React, { useState } from 'react';
import { Loader2, ChevronRight, Table2, Eye, FunctionSquare, Code, Database } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { useUiStore } from '@/app/store/uiStore';
import { landingForGoal } from '../lib/onboardingLanding';
import { PROVIDER_SETTINGS } from '@/shared/lib/provider-settings';

const ROLES = ['Developer', 'DBA', 'Data Engineer', 'Analyst', 'Student', 'Other'];
/** Preferred order for the database step; any new PROVIDER_SETTINGS entry is appended. */
const DATABASE_ORDER = [
  'PostgreSQL',
  'MySQL',
  'MariaDB',
  'SQL Server',
  'Oracle',
  'IBM DB2',
  'SQLite',
  'DuckDB',
  'CockroachDB',
  'YugabyteDB',
  'TiDB',
  'MongoDB',
  'Redis',
];
const DATABASES = (() => {
  const labels = Object.values(PROVIDER_SETTINGS).map((p) => p.label);
  const rank = new Map<string, number>(DATABASE_ORDER.map((label, i) => [label, i]));
  return [...labels].sort((a, b) => {
    const ai = rank.get(a) ?? 1000;
    const bi = rank.get(b) ?? 1000;
    return ai !== bi ? ai - bi : a.localeCompare(b);
  });
})();
const GOALS: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: 'COMPARE_SCHEMAS', label: 'Compare schemas', icon: <Table2 className="w-5 h-5" /> },
  { id: 'GENERATE_SQL', label: 'Generate migration SQL', icon: <Code className="w-5 h-5" /> },
  { id: 'EXPLORE_DATABASE', label: 'Explore a database', icon: <Eye className="w-5 h-5" /> },
  { id: 'CREATE_DOCUMENTATION', label: 'Document a schema', icon: <FunctionSquare className="w-5 h-5" /> },
];

export const OnboardingWizard: React.FC = () => {
  const { completeOnboarding, busy, error } = useAuthStore();
  const [step, setStep] = useState(0);
  const [role, setRole] = useState<string>();
  const [primaryDatabase, setPrimaryDatabase] = useState<string>();
  const [primaryGoal, setPrimaryGoal] = useState<string>();

  const steps = [
    {
      title: 'What best describes you?',
      options: ROLES,
      value: role,
      pick: (v: string) => { setRole(v); setStep(1); },
    },
    {
      title: 'Which database do you use most?',
      options: DATABASES,
      value: primaryDatabase,
      pick: (v: string) => { setPrimaryDatabase(v); setStep(2); },
    },
  ];

  /**
   * Finish with whatever has been answered so far. Every step is optional: a
   * survey you cannot leave stands between a new user and the product, which
   * is the opposite of what a welcome is for.
   */
  const finish = async (goal?: string) => {
    setPrimaryGoal(goal);
    await completeOnboarding({
      ...(role ? { role } : {}),
      ...(primaryDatabase ? { primaryDatabase } : {}),
      ...(goal ? { primaryGoal: goal } : {}),
    });
    if (useAuthStore.getState().status !== 'ready') return;
    const landing = landingForGoal(goal);
    if (!landing) return;
    const ui = useUiStore.getState();
    if (landing.syncPane) ui.setSyncPane(landing.syncPane);
    ui.setActiveView(landing.view);
  };

  const optionGridClass =
    step === 1
      ? 'grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[min(28rem,55vh)] overflow-y-auto pr-0.5'
      : 'grid grid-cols-2 gap-3';

  return (
    <div className="h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-2xl">
        <div className="flex items-center justify-center gap-2 mb-2 text-slate-500">
          {[0, 1, 2].map((i) => (
            <span key={i} className={`h-1.5 w-10 rounded-full ${i <= step ? 'bg-cyan-500' : 'bg-slate-800'}`} />
          ))}
        </div>
        <p className="text-center text-xs text-slate-500 mb-6">Step {step + 1} of 3</p>

        {step < 2 ? (
          <div>
            <h2 className="text-lg font-bold text-center mb-6">{steps[step].title}</h2>
            <div className={optionGridClass} data-testid={step === 1 ? 'onboarding-databases' : undefined}>
              {steps[step].options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  data-testid={step === 1 ? `onboarding-db-${opt}` : undefined}
                  onClick={() => steps[step].pick(opt)}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-sm font-semibold transition cursor-pointer ${
                    steps[step].value === opt
                      ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-300'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-600 text-slate-200'
                  }`}
                >
                  <span className="truncate">{opt}</span>
                  <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-lg font-bold text-center mb-6">What would you like to do first?</h2>
            <div className="grid grid-cols-1 gap-3">
              {GOALS.map((g) => (
                <button
                  key={g.id}
                  disabled={busy}
                  data-testid={`onboarding-goal-${g.id}`}
                  onClick={() => void finish(g.id)}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg border border-slate-800 bg-slate-900/60 hover:border-cyan-500/40 hover:bg-cyan-500/5 text-sm font-semibold text-slate-200 transition cursor-pointer disabled:opacity-60"
                >
                  <span className="text-cyan-400">{g.icon}</span>
                  {g.label}
                  {busy && primaryGoal === g.id && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-center gap-6">
          {step > 0 && (
            <button data-testid="onboarding-back"
              type="button"
              disabled={busy}
              onClick={() => setStep(step - 1)}
              className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50"
            >
              ← Back
            </button>
          )}
          <button
            type="button"
            data-testid="onboarding-skip"
            disabled={busy}
            onClick={() => void finish()}
            className="text-xs font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-50"
          >
            {busy && primaryGoal === undefined ? 'Skipping…' : 'Skip — take me to the app'}
          </button>
        </div>
        {error && <p className="mt-4 text-xs text-rose-400 text-center">{error}</p>}

        <div className="flex items-center justify-center gap-1.5 mt-8 text-slate-700">
          <Database className="w-3.5 h-3.5" />
          <span className="text-[10px] uppercase tracking-wider">Fox</span>
        </div>
      </div>
    </div>
  );
};
