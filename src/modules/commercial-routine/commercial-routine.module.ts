import { Module } from '@nestjs/common';
import { CommercialRoutineService } from './commercial-routine.service';
import { CommercialRoutineController } from './commercial-routine.controller';

@Module({
  controllers: [CommercialRoutineController],
  providers: [CommercialRoutineService],
  exports: [CommercialRoutineService],
})
export class CommercialRoutineModule {}
