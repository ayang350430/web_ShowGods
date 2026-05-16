<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

interface Props {
  amountData?: number[];
  categories?: string[];
  quantityData?: number[];
}

const props = withDefaults(defineProps<Props>(), {
  amountData: () => [0],
  categories: () => ['暂无数据'],
  quantityData: () => [0],
});

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

function renderChart() {
  renderEcharts({
    grid: {
      bottom: 0,
      containLabel: true,
      left: '1%',
      right: '1%',
      top: '8%',
    },
    legend: {
      data: ['消费金额', '下单量'],
      top: 0,
    },
    series: [
      {
        barMaxWidth: 60,
        data: props.amountData,
        name: '消费金额',
        type: 'bar',
      },
      {
        barMaxWidth: 60,
        data: props.quantityData,
        name: '下单量',
        type: 'bar',
      },
    ],
    tooltip: {
      trigger: 'axis',
    },
    xAxis: {
      data: props.categories,
      type: 'category',
    },
    yAxis: {
      splitNumber: 4,
      type: 'value',
    },
  });
}

onMounted(renderChart);
watch(
  () => [props.amountData, props.categories, props.quantityData],
  renderChart,
  { deep: true },
);
</script>

<template>
  <EchartsUI ref="chartRef" />
</template>
