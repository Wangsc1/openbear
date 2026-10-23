<script setup>
import brain from '../../assets/model-icons/brain.svg';
import zap from '../../assets/model-icons/zap.svg';
import compression from '../../assets/model-icons/file-archive.svg';

defineProps({name: {type: String, required: true}});
const icons = {brain, zap, compression};
</script>

<template>
	<span class="model-feature-icon" aria-hidden="true" :style="{'--feature-svg': `url(&quot;${icons[name]}&quot;)`}"></span>
</template>

<style scoped>
.model-feature-icon {
	display: inline-block;
	flex: 0 0 auto;
	width: 1em;
	height: 1em;
	background: currentColor;
	-webkit-mask: var(--feature-svg) center / contain no-repeat;
	mask: var(--feature-svg) center / contain no-repeat;
}
</style>
