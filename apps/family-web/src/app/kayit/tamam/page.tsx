import { Suspense } from 'react';

import { Done } from './Done';

export default function Tamam() {
  return (
    <Suspense>
      <Done />
    </Suspense>
  );
}
