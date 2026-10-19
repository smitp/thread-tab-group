import { LocalRepository } from '../repository';

export class FirefoxRepository extends LocalRepository {
  constructor() { super(browser.storage.local); }
}
