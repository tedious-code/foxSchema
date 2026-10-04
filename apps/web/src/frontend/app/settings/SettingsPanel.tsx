/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Preferences: appearance, app database, updates, and security.
 * Rail workspace by default; Profile can still open the same panel as a modal.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Sun,
  Moon,
  Monitor,
  Palette,
  Type,
  RotateCcw,
  ShieldCheck,
  Database,
  ArrowUpCircle,
  Sparkles,
  Settings,
} from 'lucide-react';
import {
  useUiStore,
  ACCENTS,
  TONES,
  FONT_SIZES,
  THEME_PRESETS,
  type ThemeMode,
  type AccentId,
  type ThemePreset,
} from '@/app/store/uiStore';
import { fetchAppInfo, type AppInfo } from '@/features/auth';
import { EmailSettings } from './EmailSettings';
import { UpdatesSettings } from './UpdatesSettings';

interface Props {
  open?: boolean;
  onClose?: () => void;
  embedded?: boolean;
}

type SettingsTab = 'appearance' | 'database' | 'updates' | 'security';

const MODES: { id: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { id: 'light', label: 'Light', icon: <Sun className="w-4 h-4" /> },
  { id: 'dark', label: 'Dark', icon: <Moon className="w-4 h-4" /> },
  { id: 'system', label: 'System', icon: <Monitor className="w-4 h-4" /> },
];

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'database', label: 'Database' },
  { id: 'updates', label: 'Updates' },
  { id: 'security', label: 'Security' },
];

const TONE_SWATCH: Record<string, string> = {
  slate: '#64748b',
  gray: '#6b7280',
  zinc: '#71717a',
  stone: '#78716c',
  neutral: '#737373',
};

const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({
  icon,
  title,
  children,
}) => (
  <div className="space-y-2">
    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider flex items-center gap-1.5">
      {icon} {title}
    </p>
    {children}
  </div>
);

/** Preferences: theme, app database, updates, and encryption binding. Changes apply live. */
export const SettingsPanel: React.FC<Props> = ({ open = true, onClose, embedded = false }) => {
  const {
    themeMode,
    tone,
    fontSize,
    accent,
    setThemeMode,
    setTone,
    setFontSize,
    setAccent,
    applyPreset,
    resetAppearance,
  } = useUiStore();
  const presetActive = (p: ThemePreset) => themeMode === p.mode && tone === p.tone && accent === p.accent;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<SettingsTab>('appearance');

  useEffect(() => {
    if (!embedded && !open) return;
    let alive = true;
    fetchAppInfo()
      .then((i) => alive && setInfo(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, embedded]);

  if (!embedded && !open) return null;

  const optionBtn = (active: boolean) =>
    `transition cursor-pointer border ${
      active
        ? 'bg-slate-800 border-cyan-500/40 text-slate-100'
        : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
    }`;

  const appearance = (
    <div className="space-y-6">
      <Section icon={<Sparkles className="w-3 h-3" />} title="Theme Presets">
        <div className="grid grid-cols-2 gap-2">
          {THEME_PRESETS.map((p) => {
            const active = presetActive(p);
            const dark = p.mode === 'dark';
            return (
              <button data-testid={`settings-apply-preset-${p.id}`}
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                title={`${p.label} — ${dark ? 'Dark' : 'Light'} · ${p.tone} · ${ACCENTS[p.accent].label}`}
                className={`flex items-center gap-2.5 p-1.5 rounded-lg ${optionBtn(active)}`}
              >
                <div
                  className="h-9 w-12 rounded-md overflow-hidden flex shrink-0 border border-black/30"
                  style={{ background: dark ? '#0b0f17' : '#eef2f7' }}
                >
                  <div style={{ width: '34%', backgroundColor: TONE_SWATCH[p.tone] }} />
                  <div className="flex-1" />
                  <div
                    style={{
                      width: 5,
                      backgroundImage: `linear-gradient(to bottom, ${ACCENTS[p.accent].from}, ${ACCENTS[p.accent].to})`,
                    }}
                  />
                </div>
                <div className="min-w-0 text-left">
                  <div className="text-xs font-semibold flex items-center gap-1">
                    {dark ? <Moon className="w-3 h-3 opacity-60" /> : <Sun className="w-3 h-3 opacity-60" />}
                    {p.label}
                  </div>
                  <div className="text-[10px] text-slate-500 capitalize truncate">
                    {p.tone} · {ACCENTS[p.accent].label}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={<Monitor className="w-3 h-3" />} title="Background">
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button data-testid={`settings-theme-mode-${m.id}`}
              key={m.id}
              type="button"
              onClick={() => setThemeMode(m.id)}
              className={`flex flex-col items-center gap-1.5 py-3 rounded-lg text-xs font-semibold ${optionBtn(themeMode === m.id)}`}
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>
      </Section>

      <Section icon={<Palette className="w-3 h-3" />} title="UI Tone">
        <div className="flex flex-wrap gap-2">
          {TONES.map((t) => (
            <button data-testid={`settings-tone-${t.id}`}
              key={t.id}
              type="button"
              onClick={() => setTone(t.id)}
              className={`flex items-center gap-1.5 pl-1.5 pr-3 py-1.5 rounded-md text-xs font-semibold ${optionBtn(tone === t.id)}`}
            >
              <span
                className="w-4 h-4 rounded-full border border-white/10"
                style={{ backgroundColor: TONE_SWATCH[t.id] }}
              />
              {t.label}
            </button>
          ))}
        </div>
      </Section>

      <Section icon={<span className="w-2.5 h-2.5 rounded-full accent-grad inline-block" />} title="Accent">
        <div className="flex gap-2.5">
          {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
            <button data-testid={`settings-accent-${id}`}
              key={id}
              type="button"
              onClick={() => setAccent(id)}
              title={ACCENTS[id].label}
              className={`w-8 h-8 rounded-full transition cursor-pointer ${
                accent === id ? 'ring-2 ring-offset-2 ring-offset-slate-900 ring-white/70' : 'hover:scale-110'
              }`}
              style={{
                backgroundImage: `linear-gradient(to top right, ${ACCENTS[id].from}, ${ACCENTS[id].to})`,
              }}
            />
          ))}
        </div>
      </Section>

      <Section icon={<Type className="w-3 h-3" />} title="Text Size">
        <div className="grid grid-cols-4 gap-2">
          {FONT_SIZES.map((f, i) => (
            <button data-testid={`settings-font-${f.id}`}
              key={f.id}
              type="button"
              onClick={() => setFontSize(f.id)}
              title={f.label}
              className={`flex items-center justify-center py-2 rounded-md font-bold ${optionBtn(fontSize === f.id)}`}
              style={{ fontSize: `${0.72 + i * 0.13}rem` }}
            >
              Aa
            </button>
          ))}
        </div>
      </Section>
    </div>
  );

  const body = (
    <div
      className={
        embedded
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'flex max-h-[min(90vh,44rem)] flex-col'
      }
      data-testid="settings-view"
    >
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-cyan-400" />
          <div>
            <h2 className="text-slate-100 font-bold text-base">Preferences</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Personalize the whole interface · changes apply instantly
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button data-testid="settings-reset"
            type="button"
            onClick={resetAppearance}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
          {onClose && (
            <button data-testid="settings-close"
              type="button"
              onClick={onClose}
              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      <nav
        className="shrink-0 flex flex-wrap gap-1 px-4 pt-3 pb-0"
        aria-label="Preferences"
        data-testid="settings-menu"
      >
        {TABS.map((s) => {
          const active = tab === s.id;
          return (
            <button
              key={s.id}
              type="button"
              data-testid={`settings-tab-${s.id}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => setTab(s.id)}
              className={`rounded px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                active
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </nav>

      <div className={`min-h-0 flex-1 overflow-y-auto p-6 ${embedded ? '' : ''}`}>
        {tab === 'appearance' && appearance}
        {tab === 'database' && (
          <Section icon={<Database className="w-3 h-3" />} title="Database">
            {info ? (
              <p className="text-xs text-slate-300">
                <span className="font-mono text-slate-200">{info.db.engine}</span>
                {info.db.location && info.db.location !== '(default)'
                  ? ` · ${info.db.location}`
                  : ''}{' '}
                — managed by the server.
              </p>
            ) : (
              <p className="text-xs text-slate-500">Loading app database info…</p>
            )}
          </Section>
        )}
        {tab === 'updates' && (
          <Section icon={<ArrowUpCircle className="w-3 h-3" />} title="Updates">
            <UpdatesSettings />
          </Section>
        )}
        {tab === 'security' && (
          <Section icon={<ShieldCheck className="w-3 h-3" />} title="Security">
            <div className="px-3 py-2.5 rounded-lg border border-slate-800 bg-slate-950/40 text-xs">
              {info ? (
                <EmailSettings info={info} onUpdated={setInfo} />
              ) : (
                <p className="text-slate-500">Loading encryption binding…</p>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-slate-950" data-testid="settings-workspace">
        {body}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>,
    document.body
  );
};
