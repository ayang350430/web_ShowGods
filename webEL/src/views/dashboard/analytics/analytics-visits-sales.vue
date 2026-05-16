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
    { name: '可用', value: 0 },
    { name: '冷却中', value: 0 },
    { name: '失效', value: 0 },
    { name: '已禁用', value: 0 },
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
        color: ['#019680', '#e6a23c', '#f56c6c', '#909399'],
        data: normalizeData(props.data),
        name: '账号池',
        radius: '80%',
        roseType: 'radius',
        type: 'pie',
      },
    ],
    tooltip: {
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
