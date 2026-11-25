<script setup lang="ts">
/**
 * A runnable example embedded in a manual page: `<ExampleFrame id="hello-globe" />`.
 *
 * The example only starts when the reader clicks (every running example holds a GPU device and
 * downloads tiles). The examples are a separate Vite build published at `<site>/examples/<id>/`;
 * under `npm run docs:dev` they come from `npm run examples:dev` (port 5175), started separately.
 */
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';
import { findExample, REPO } from '../../../examples/catalog';

const props = defineProps<{ id: string; height?: number }>();
const info = computed(() => findExample(props.id));
const running = ref(false);
const src = computed(() => (import.meta.env.DEV ? `http://localhost:5175/${props.id}/` : withBase(`/examples/${props.id}/`)));
const source = computed(() => `${REPO}/blob/main/examples/${props.id}/main.ts`);
</script>

<template>
  <figure class="tv-example">
    <figcaption class="tv-example-bar">
      <span class="tv-example-title">示例 · {{ info.title }}</span>
      <a :href="src" target="_blank" rel="noopener">新窗口打开</a>
      <a :href="source" target="_blank" rel="noreferrer">源码</a>
    </figcaption>
    <div class="tv-example-stage" :style="{ height: `${height ?? 540}px` }">
      <iframe v-if="running" :src="src" :title="info.title" allow="fullscreen" />
      <button v-else type="button" class="tv-example-run" @click="running = true">
        <span class="tv-example-play">▶</span>
        <span>运行示例</span>
        <small>{{ info.summary }}</small>
      </button>
    </div>
  </figure>
</template>
