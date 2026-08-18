import { motion } from 'framer-motion';
import { DecodeText, Reveal, useLenis } from '@/components/brain/anim';
import CortexGauge from '@/components/health/CortexGauge';
import KpiRow from '@/components/health/KpiRow';
import { PredictionErrorChart, RecallSignalChart } from '@/components/health/RecallCharts';
import ReflexActivity from '@/components/health/ReflexActivity';
import { DecayCurve, WeightHistogram } from '@/components/health/MemoryPhysics';
import { ArousalChart, SlotUtilizationChart } from '@/components/health/WorkingArousal';
import GrowthChart from '@/components/health/GrowthChart';

/** Section divider with hex-grid strip (health.md assets note). */
function SectionDivider({ label }: { label: string }) {
  return (
    <div className="relative mt-8 mb-4 flex items-center gap-4">
      <span className="micro-label shrink-0">{label}</span>
      <div
        className="h-[14px] flex-1 opacity-[0.06]"
        style={{ backgroundImage: "url('/grid-hex.svg')", backgroundSize: '128px' }}
      />
      <div className="holo-divider absolute inset-x-0 bottom-0" />
    </div>
  );
}

/**
 * BRAIN HEALTH (/health) — health.md.
 * JARVIS diagnostics wall: is the brain getting smarter?
 */
export default function Health() {
  useLenis();

  return (
    <div className="relative z-10 mx-auto w-full max-w-[1500px] px-4 pb-16 pt-8 lg:px-8">
      <header>
        <h1 className="font-display text-[26px] font-bold tracking-[0.14em] text-hi text-glow lg:text-[30px]">
          <DecodeText text="BRAIN HEALTH" duration={600} />
        </h1>
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.35 }}
          className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-dim"
        >
          Telemetry Diagnostics · 30-Day Window · Is the brain getting smarter?
        </motion.p>
      </header>

      {/* SECTION 1 — cortex integrity hero */}
      <Reveal className="mt-6">
        <div className="holo-panel holo-corners p-5 lg:p-6">
          <CortexGauge />
        </div>
      </Reveal>

      {/* SECTION 2 — KPI cards */}
      <div className="mt-4">
        <KpiRow />
      </div>

      {/* SECTION 3 — recall & learning */}
      <SectionDivider label="Recall & Learning" />
      <div className="grid grid-cols-12 gap-4">
        <Reveal className="col-span-12 xl:col-span-6" amount={0.2}>
          <RecallSignalChart />
        </Reveal>
        <Reveal className="col-span-12 xl:col-span-6" amount={0.2} delay={0.1}>
          <PredictionErrorChart />
        </Reveal>
      </div>

      {/* SECTION 4 — reflex activity */}
      <SectionDivider label="Reflex Activity" />
      <Reveal amount={0.2}>
        <ReflexActivity />
      </Reveal>

      {/* SECTION 5 — memory physics */}
      <SectionDivider label="Memory Physics" />
      <div className="grid grid-cols-12 gap-4">
        <Reveal className="col-span-12 xl:col-span-7" amount={0.2}>
          <DecayCurve />
        </Reveal>
        <Reveal className="col-span-12 xl:col-span-5" amount={0.2} delay={0.1}>
          <WeightHistogram />
        </Reveal>
      </div>

      {/* SECTION 6 — working memory & arousal */}
      <SectionDivider label="Working Memory & Arousal" />
      <div className="grid grid-cols-12 gap-4">
        <Reveal className="col-span-12 xl:col-span-6" amount={0.2}>
          <SlotUtilizationChart />
        </Reveal>
        <Reveal className="col-span-12 xl:col-span-6" amount={0.2} delay={0.1}>
          <ArousalChart />
        </Reveal>
      </div>

      {/* SECTION 7 — growth & consolidation */}
      <SectionDivider label="Growth & Consolidation" />
      <Reveal amount={0.2}>
        <GrowthChart />
      </Reveal>
    </div>
  );
}
