import { Module } from '@nestjs/common';

import { FieldCipher } from '../../common/field-cipher';
import { EnrollmentModule } from '../device/enrollment.module';
import { EventModule } from '../event/event.module';
import { GEOCODER, geocoderFromEnv } from './geocoder';
import { FamilyMembersController, ProfileController, ProfileGuard } from './profile.controller';
import { FIELD_CIPHER, ProfileService } from './profile.service';

/** T-040 profil + sağlık (health.medical_summary). Davet kodu EnrollmentService'ten (T-041). */
@Module({
  imports: [EnrollmentModule, EventModule],
  controllers: [ProfileController, FamilyMembersController],
  providers: [
    ProfileService,
    ProfileGuard,
    { provide: FIELD_CIPHER, useFactory: () => FieldCipher.fromEnv() },
    { provide: GEOCODER, useFactory: () => geocoderFromEnv() },
  ],
  exports: [ProfileService, ProfileGuard],
})
export class ProfileModule {}
