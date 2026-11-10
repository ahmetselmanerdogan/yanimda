import { Suspense } from 'react';

import { FakeCheckout } from './FakeCheckout';

export default function Sahte() {
  return (
    <Suspense>
      <FakeCheckout />
    </Suspense>
  );
}
