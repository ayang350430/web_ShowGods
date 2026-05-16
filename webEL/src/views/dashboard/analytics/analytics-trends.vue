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
  amountData: () => [0, 0, 0],
  categories: () => ['昨日', '今日', '累计'],
  quantityData: () => [0, 0, 0],
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
      top: '5%',
    },
    legend: {
      data: ['下单量', '消费金额'],
      top: 0,
    },
    series: [
      {
        areaStyle: {},
        data: props.quantityData,
        itemStyle: {
          color: '#5ab1ef',
        },
        name: '下单量',
        smooth: true,
        type: 'line',
      },
      {
        areaStyle: {},
        data: props.amountData,
        itemStyle: {
          color: '#019680',
        },
        name: '消费金额',
        smooth: true,
        type: 'line',
      },
    ],
    tooltip: {
      trigger: 'axis',
    },
    xAxis: {
      axisTick: {
        show: false,
      },
      boundaryGap: false,
      data: props.categories,
      splitLine: {
        lineStyle: {
          type: 'solid',
          width: 1,
        },
        show: true,
      },
      type: 'category',
    },
    yAxis: [
      {
        axisTick: {
          show: false,
        },
        splitArea: {
          show: true,
        },
        splitNumber: 4,
        type: 'value',
      },
    ],
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
