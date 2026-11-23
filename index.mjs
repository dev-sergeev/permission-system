import installGate from './dist/gate.mjs';
import installReviewer from './dist/reviewer.mjs';

export default function permissionSystem(pi) {
  // The reviewer must be listening when the gate announces its session service.
  installReviewer(pi);
  installGate(pi);
}
