<script setup>
import { computed } from 'vue';
const props = defineProps({ points: { type: Array, default: () => [] }, height: { type: Number, default: 44 } });

// Inline SVG rather than a chart library: one series, no interaction, and
// pulling in a charting dependency for this would be the larger cost.
const path = computed(() => {
  const vals = props.points.map(Number);
  if (vals.length < 2) return '';
  const max = Math.max(...vals, 1);
  const w = 100, h = props.height;
  return vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - (v / max) * (h - 4) - 2;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
});
</script>

<template>
  <svg v-if="path" :viewBox="`0 0 100 ${height}`" preserveAspectRatio="none"
       :style="{ width: '100%', height: height + 'px' }" role="img" aria-label="usage trend">
    <path :d="path" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
  </svg>
  <p v-else class="muted" style="font-size:12px;margin:8px 0 0">Not enough data yet.</p>
</template>
