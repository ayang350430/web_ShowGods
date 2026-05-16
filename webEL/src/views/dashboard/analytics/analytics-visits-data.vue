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
    { name: '今日消费', value: 0 },
    { name: '昨日消费', value: 0 },
    { name: '历史消费', value: 0 },
  ],
});

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

function normalizeData(data: ChartDatum[]) {
  return data.some((item) => item.value > 0)
    ? data
    : [{ name: '暂无数据', value: 1 }];
}

function renderChart() {
  renderEcharts({
    legend: {
      bottom: 0,
      left: 'center',
    },
    series: [
      {
        color: ['#5ab1ef', '#019680', '#b6a2de'],
        data: normalizeData(props.data),
        itemStyle: {
          borderRadius: 8,
          borderWidth: 2,
        },
        name: '金额分布',
        radius: ['35%', '65%'],
        type: 'pie',
      },
    ],
    tooltip: {
      trigger: 'item',
      valueFormatter(value) {
        return `¥${Number(value).toFixed(2)}`;
      },
    },
  });
}

onMounted(renderChart);
watch(() => props.data, renderChart, { deep: true });
</script>

<template>
  <EchartsUI ref="chartRef" />
</template>
