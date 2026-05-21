<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

interface ChartDatum {
  name: string;
  value: number;
}

interface Props {
  data?: ChartDatum[];
}

const props = withDefaults(defineProps<Props>(), {
  data: () => [
    { name: '预览', value: 0 },
    { name: '提交', value: 0 },
    { name: '进度查询', value: 0 },
    { name: '停止', value: 0 },
  ],
});

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

function normalizeData(data: ChartDatum[]) {
  return data.some((item) => item.value > 0)
    ? data.toSorted((a, b) => a.value - b.value)
    : [{ name: '暂无数据', value: 1 }];
}

function renderChart() {
  renderEcharts({
    series: [
      {
        animationDelay() {
          return Math.random() * 400;
        },
        animationEasing: 'exponentialInOut',
        animationType: 'scale',
        center: ['50%', '50%'],
        color: ['#409eff', '#67c23a', '#e6a23c', '#f56c6c'],
        data: normalizeData(props.data),
        label: {
          formatter: '{b}: {c}',
        },
        name: 'API 调用',
        radius: ['40%', '70%'],
        type: 'pie',
      },
    ],
    tooltip: {
      formatter: '{b}: {c} 次 ({d}%)',
      trigger: 'item',
    },
  });
}

onMounted(renderChart);
watch(() => props.data, renderChart, { deep: true });
</script>

<template>
  <EchartsUI ref="chartRef" />
</template>
