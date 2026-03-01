/**
 * Cart Pro V3 — entry point.
 * Single global CSS; component CSS is injected into shadow root via mount.
 */
console.log("[CartPro V3] Runtime version marker:", "BUILD_ID_123");
import { mountCartProV3 } from './mount';
import './styles/cart-pro-v2.css';
import componentStyles from 'virtual:cart-pro-v3-component-css';

mountCartProV3(componentStyles ?? '');
