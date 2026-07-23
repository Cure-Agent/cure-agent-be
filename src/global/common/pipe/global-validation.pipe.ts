import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ServiceException } from '../exception/service.exception';

interface FieldError {
  field: string;
  constraints: string[];
}

function flatten(errors: ValidationError[], parentPath = ''): FieldError[] {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own: FieldError[] = error.constraints
      ? [{ field: path, constraints: Object.values(error.constraints) }]
      : [];
    return [...own, ...flatten(error.children ?? [], path)];
  });
}

/**
 * 전역 ValidationPipe (architecture.md §10.2).
 * 검증 실패는 VALIDATION_FAILED(422) 봉투로 수렴하고, 필드 상세를 data에 싣는다.
 */
export function buildGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) => new ServiceException('VALIDATION_FAILED', { errors: flatten(errors) }),
  });
}
