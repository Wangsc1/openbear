<script setup>
import {onBeforeUnmount, ref} from "vue";
import {getThemeState, subscribeTheme} from "../theme.js";

const dark = ref(getThemeState().dark);
const stopTheme = subscribeTheme(state => { dark.value = state.dark; });
onBeforeUnmount(stopTheme);
</script>

<template>
  <img
    class="bear-logo"
    :src="dark ? '/assets/brand/openbear-d60af5867ad8.png' : '/assets/brand/openbear-light-7c79cbb79f15.png'"
    width="512"
    height="512"
    alt="OpenBear"
    draggable="false"
  />
</template>

<style scoped>
.bear-logo {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 22%;
  /* Both variants retain the artwork; only the UI background follows the theme. */
}
</style>
