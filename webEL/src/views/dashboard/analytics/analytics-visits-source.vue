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
    { name: '进行中', value: 0 },
    { name: '已完成', value: 0 },
    { name: '失败', value: 0 },
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
      bottom: '2%',
      left: 'center',
    },
    series: [
      {
        animationDelay() {
          return Math.random() * 100;
        },
        animationEasing: 'exponentialInOut',
        animationType: 'scale',
        avoidLabelOverlap: false,
        color: ['#5ab1ef', '#019680', '#f56c6c', '#b6a2de', '#e6a23c'],
        data: normalizeData(props.data),
        emphasis: {
          label: {
            fontSize: '12',
            fontWeight: 'bold',
            show: true,
          },
        },
        itemStyle: {
          borderRadius: 10,
          borderWidth: 2,
        },
        label: {
          position: 'center',
          show: false,
        },
        labelLine: {
          show: false,
        },
        name: '订单状态',
        radius: ['40%', '65%'],
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
