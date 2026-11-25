/** Site theme: VitePress's default theme plus `<ExampleFrame id="…" />` for the manual pages. */
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import ExampleFrame from './ExampleFrame.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ExampleFrame', ExampleFrame);
  },
} satisfies Theme;
