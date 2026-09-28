import mobileCompat from './postcss-mobile-compat.js';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

export default {
  plugins: [mobileCompat(), tailwindcss(), autoprefixer()],
};
