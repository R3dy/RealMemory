import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, Hexagon, RotateCcw, Search } from 'lucide-react';
import { TYPE_COLORS, weightColor } from '@/lib/colors';
import HoloPanel from '@/components/HoloPanel';
import DomainCard from '@/components/atlas/DomainCard';
import SynapseChordMap from '@/components/atlas/SynapseChordMap';
import {
  computeCrossDomainLinks,
  computeDomainStats,
  type DomainStats,
} from '@/components/atlas/domain-stats';
import { CountUp, DecodeText, timeAgo, useLenis, absoluteTime } from '@/components/index-table/hud';
import { cn } from '@/lib/utils';

type SectorSort = 'count' | 'weight' | 'recent';

const SORT_OPTIONS: { key: SectorSort; label: string }[] = [
  { key: 'count', label: 'COUNT' },
  { key: 'weight', label: 'WEIGHT' },
  { key: 'recent', label: 'RECENT' },
];

function sortSectors(list: DomainStats[], sort: SectorSort): DomainStats[] {
  const copy = [...list];
  if (sort === 'count') copy.sort((a, b) => b.count - a.count);
  else if (sort === 'weight') copy.sort((a, b) => b.avgWeight - a.avgWeight);
  else copy.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return copy;
}

export default function Domains() {
  useLenis();
  const navigate = useNavigate();
  const [sort, setSort] = useState<SectorSort>('count');
  const [search, setSearch] = useState('');

  const allStats = useMemo(() => computeDomainStats(), []);
  const links = useMemo(() => computeCrossDomainLinks(), []);
  const mapped = useMemo(() => allStats.reduce((s, d) => s + d.count, 0), [allStats]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? allStats.filter((d) => d.name.toLowerCase().includes(q)) : allStats;
    return sortSectors(filtered, sort);
  }, [allStats, search, sort]);

  const focus = useCallback(
    (domain: string) => {
      navigate(`/?domain=${encodeURIComponent(domain)}`);
    },
    [navigate],
  );

  return (
    <div className="relative min-h-full pb-10">
      {/* ---- SECTION 1 · page header ---- */}
      <div className="px-6 pt-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] font-bold leading-none tracking-[0.14em] text-hi text-glow">
              <DecodeText text="DOMAIN ATLAS" />
            </h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className="micro-label mt-2"
            >
              {allStats.length} KNOWLEDGE SECTORS · <CountUp value={mapped} className="text-arc" /> ENGRAMS
              MAPPED
            </motion.p>
          </div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-wrap items-center gap-3"
          >
            {/* sort segmented control */}
            <div className="relative flex items-center rounded-full border border-panel-border bg-[rgba(2,6,14,0.5)] p-[3px]">
              {SORT_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setSort(o.key)}
                  className={cn(
                    'relative z-10 rounded-full px-3 py-1 font-display text-[10px] font-bold tracking-[0.14em] transition-colors duration-200',
                    sort === o.key ? 'text-void' : 'text-dim hover:text-arc',
                  )}
                >
                  {sort === o.key && (
                    <motion.span
                      layoutId="atlas-sort-thumb"
                      className="absolute inset-0 -z-10 rounded-full bg-arc shadow-[0_0_10px_rgba(0,212,255,0.5)]"
                      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                    />
                  )}
                  {o.label}
                </button>
              ))}
            </div>
            {/* search */}
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-arc" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter sectors…"
                className="w-[180px] rounded-md border border-panel-border bg-[rgba(2,6,14,0.5)] py-1.5 pl-7 pr-2.5 text-[13px] text-hi outline-none transition-colors placeholder:text-dim focus:border-panel-hot"
              />
            </div>
          </motion.div>
        </div>
        <motion.div
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="holo-divider mt-4 origin-left"
        />
      </div>

      {/* ---- SECTION 2 · sector grid ---- */}
      <div className="px-6 pt-5">
        {visible.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <AnimatePresence mode="popLayout">
              {visible.map((stats, i) => (
                <DomainCard key={stats.name} stats={stats} index={i} onFocus={focus} />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="holo-panel holo-corners flex h-[240px] flex-col items-center justify-center gap-4"
          >
            <Hexagon size={44} className="text-dim" />
            <span className="font-display text-[13px] font-bold tracking-[0.2em] text-mid">
              NO SECTOR MATCHES
            </span>
            <button
              type="button"
              onClick={() => setSearch('')}
              className="flex items-center gap-1.5 rounded-md border border-panel-hot px-4 py-1.5 font-display text-[10px] font-bold tracking-[0.18em] text-arc transition-shadow hover:shadow-glow-arc"
            >
              <RotateCcw size={12} />
              RESET
            </button>
          </motion.div>
        )}
      </div>

      {/* ---- SECTION 3 · inter-sector synapse map ---- */}
      <div className="relative mt-8 px-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{ background: 'url(/grid-hex.svg) repeat', backgroundSize: '256px' }}
        />
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <HoloPanel title="INTER-SECTOR SYNAPSE MAP" corners>
            <SynapseChordMap domains={allStats} links={links} />
          </HoloPanel>
        </motion.div>
      </div>

      {/* ---- SECTION 4 · sector comparison table ---- */}
      <div className="mt-6 px-6">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <HoloPanel title="SECTOR COMPARISON" corners>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-panel-border">
                  {['Sector', 'Engrams', 'Avg Weight', 'Top Type', 'Strong / Stable / Fading', 'Last Activity'].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-4 py-2.5 text-left font-display text-[10px] font-bold tracking-[0.16em] text-dim last:text-right"
                      >
                        {h.toUpperCase()}
                      </th>
                    ),
                  )}
                  <th className="w-8 border-b border-panel-border" />
                </tr>
              </thead>
              <tbody>
                {visible.map((d, i) => {
                  const typeColor = TYPE_COLORS[d.topType];
                  return (
                    <motion.tr
                      key={d.name}
                      initial={{ opacity: 0, y: 10 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true, amount: 0.4 }}
                      transition={{ duration: 0.35, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                      onClick={() => focus(d.name)}
                      className={cn(
                        'group cursor-pointer border-b border-[rgba(0,212,255,0.06)] transition-colors duration-200 hover:bg-[rgba(0,212,255,0.06)]',
                        i % 2 === 1 && 'bg-[rgba(0,212,255,0.02)]',
                      )}
                    >
                      <td className="px-4 py-3">
                        <span className="font-display text-[12px] font-bold tracking-[0.12em] text-hi">
                          {d.name.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[13px] font-bold text-arc">{d.count}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <span className="h-[5px] w-[60px] overflow-hidden rounded-full bg-[rgba(0,212,255,0.1)]">
                            <motion.span
                              className="block h-full rounded-full"
                              initial={{ width: 0 }}
                              whileInView={{ width: `${d.avgWeight * 100}%` }}
                              viewport={{ once: true }}
                              transition={{ duration: 0.4, delay: 0.2 + i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                              style={{
                                backgroundColor: weightColor(d.avgWeight),
                                boxShadow: `0 0 6px ${weightColor(d.avgWeight)}`,
                              }}
                            />
                          </span>
                          <span className="font-mono text-[12px] font-bold" style={{ color: weightColor(d.avgWeight) }}>
                            {d.avgWeight.toFixed(2)}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: typeColor, boxShadow: `0 0 6px ${typeColor}` }}
                          />
                          <span className="font-mono text-[11px] uppercase text-mid">
                            {d.topType.replace('_', ' ')}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[11.5px] font-bold">
                          <span style={{ color: '#22ff88' }}>{d.tiers.strong}</span>
                          <span className="text-dim"> / </span>
                          <span style={{ color: '#ffd319' }}>{d.tiers.stable}</span>
                          <span className="text-dim"> / </span>
                          <span style={{ color: '#ff3355' }}>{d.tiers.fading}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right" title={absoluteTime(d.lastActivity)}>
                        <span className="whitespace-nowrap font-mono text-[11px] text-mid">
                          {timeAgo(d.lastActivity)}
                        </span>
                      </td>
                      <td className="py-3 pr-3 text-right">
                        <ChevronRight
                          size={14}
                          className="ml-auto text-dim transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-arc"
                        />
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </HoloPanel>
        </motion.div>
      </div>
    </div>
  );
}
