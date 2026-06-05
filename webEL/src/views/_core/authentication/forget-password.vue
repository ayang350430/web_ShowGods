<script lang="ts" setup>
import type { VbenFormSchema } from '@vben/common-ui';
import type { Recordable } from '@vben/types';

import { computed, ref } from 'vue';

import { AuthenticationForgetPassword, z } from '@vben/common-ui';

import { requestPasswordResetApi } from '#/api/core/auth';

defineOptions({ name: 'ForgetPassword' });

const loading = ref(false);
const submitted = ref(false);
const errorMsg = ref('');

const formSchema = computed((): VbenFormSchema[] => {
  return [
    {
      component: 'VbenInput',
      componentProps: {
        placeholder: '请输入您的账号',
      },
      fieldName: 'username',
      label: '账号',
      rules: z.string().min(1, { message: '请输入账号' }),
    },
  ];
});

async function handleSubmit(value: Recordable<any>) {
  loading.value = true;
  errorMsg.value = '';
  try {
    await requestPasswordResetApi({ username: value.username });
    submitted.value = true;
  } catch (error: any) {
    const msg =
      error?.response?.data?.message || error?.message || '提交失败，请稍后重试';
    errorMsg.value = msg;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AuthenticationForgetPassword
    v-if="!submitted"
    :form-schema="formSchema"
    :loading="loading"
    submit-button-text="提交申请"
    sub-title="输入您的账号，我们将通知管理员为您重置密码"
    title="忘记密码?"
    @submit="handleSubmit"
  >
    <template #submitButtonText>
      {{ loading ? '提交中...' : '提交申请' }}
    </template>
  </AuthenticationForgetPassword>

  <div v-if="errorMsg && !submitted" style="color: var(--el-color-danger); font-size: 13px; text-align: center; margin-top: -8px;">
    {{ errorMsg }}
  </div>

  <div v-if="submitted" style="text-align: center; padding: 40px 20px;">
    <div style="font-size: 48px; margin-bottom: 16px;">&#10004;</div>
    <h2 style="font-size: 22px; font-weight: 700; margin-bottom: 8px;">申请已提交</h2>
    <p style="color: #888; font-size: 14px; margin-bottom: 24px;">
      管理员收到通知后会为您重置密码，请耐心等待。
    </p>
    <a href="/auth/login" style="color: var(--el-color-primary); font-size: 14px; text-decoration: none;">
      返回登录
    </a>
  </div>
</template>
