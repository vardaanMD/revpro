/**
 * Cart Pro V3 — entry point.
 * Single global CSS; component CSS is injected into shadow root via mount.
 */
import { mountCartProV3 } from './mount';
import './styles/cart-pro-v2.css';
import './styles/cart-pro-v3.css';
import componentStyles from 'virtual:cart-pro-v3-component-css';

mountCartProV3(componentStyles ?? '');
