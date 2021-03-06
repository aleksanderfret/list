import { Arg, Ctx, Field, Mutation, ObjectType, Resolver } from 'type-graphql';
import { getManager } from 'typeorm';
import { compare, hash } from 'bcryptjs';

import { AccountStatus, TokenType } from '@shared/enums';
import { Context } from '@shared/types';
import {
  createAccessToken,
  createRefreshToken,
  createToken,
  sendRefreshToken,
  verifyToken
} from './auth';
import Token from './entity';
import User from '@modules/user/entity';
import { sendSignUpConfirmation } from '@modules/mailer';
import { BadRequestError, ValidationError } from '@errors/index';
import { ErrorReason } from '@errors/enums';
import environment from '@env/env';

const { APP_URL, CONFIRM_SIGN_UP_TOKEN_EXP } = environment;
@ObjectType()
class SignInResponse {
  @Field(() => User)
  user!: User;
  @Field()
  accessToken!: string;
}
@Resolver()
export class AuthResolver {
  @Mutation(() => Boolean)
  async forgotPassword(@Arg('email') email: string): Promise<Boolean> {
    try {
      await getManager().increment(User, { email }, 'tokenVersion', 1);

      // send email with link
    } catch (error) {
      console.error(error);

      return false;
    }

    return true;
  }

  @Mutation(() => Boolean)
  async signOut(@Ctx() { res }: Context) {
    res.clearCookie('refreshToken', { path: '/api/auth/refresh-token' });

    return true;
  }

  @Mutation(() => SignInResponse)
  async signIn(
    @Arg('email') email: string,
    @Arg('password') password: string,
    @Ctx() { res }: Context
  ): Promise<SignInResponse> {
    const user = await User.findOne({ where: { email } });

    if (!user) {
      throw new ValidationError(
        'Invalid credentials',
        ErrorReason.InvalidCredentialsError
      );
    }

    const valid = await compare(password, user.password);

    if (!valid) {
      throw new ValidationError(
        'Invalid credentials',
        ErrorReason.InvalidCredentialsError
      );
    }

    const { id, status, tokenVersion } = user;

    if (status !== AccountStatus.Active) {
      throw new BadRequestError(
        'Account Not Active',
        ErrorReason.AccountNotConfirmedError
      );
    }

    sendRefreshToken(res, createRefreshToken(id, tokenVersion));

    return {
      accessToken: createAccessToken(id),
      user
    };
  }

  @Mutation(() => Boolean)
  async signUp(@Arg('email') email: string, @Arg('password') password: string) {
    const user = await User.findOne({ email });

    if (user) {
      throw new BadRequestError(
        'User already exists',
        ErrorReason.AlreadyExistsError
      );
    }

    const hashedPassword = await hash(password, 12);

    const newUser = await User.insert({
      email,
      password: hashedPassword,
      status: AccountStatus.Registered
    });

    const { identifiers } = newUser;

    const [{ id }] = identifiers;

    const token = createToken(CONFIRM_SIGN_UP_TOKEN_EXP)(id);

    const {
      identifiers: [{ id: tokenId }]
    } = await Token.insert({
      token,
      type: TokenType.SignUpConfirmToken,
      user: id
    });

    const redirectUrl = `${APP_URL}/sign-up-confirmation/${tokenId}`;

    try {
      await sendSignUpConfirmation({
        recipient: email,
        redirectUrl,
        user: { email }
      });
    } catch (error) {
      console.error(error);

      throw new BadRequestError(
        'Sending confirmation failed',
        ErrorReason.SendingFailedError
      );
    }

    return true;
  }

  @Mutation(() => Boolean)
  async confirmSignUp(@Arg('tokenId') tokenId: string) {
    const token = await Token.findOne({ id: tokenId });

    if (!token) {
      // TODO If there is no token and there is no user also
      // this account was deleted due to email not being
      // confirmed for 30 days
      throw new BadRequestError();
    }

    const { token: jwtToken } = token;

    const payload = verifyToken(jwtToken, {
      ignoreExpiration: true
    });

    const { exp, userId: id } = payload;

    if (Date.now() >= exp * 1000) {
      throw new ValidationError(
        'Link has expired',
        ErrorReason.ExpiredLinkError
      );
    }

    await getManager().update(
      User,
      { id, status: AccountStatus.Registered },
      { activeAt: new Date(), status: AccountStatus.Active }
    );

    await Token.delete({ id: tokenId });

    return true;
  }

  @Mutation(() => Boolean)
  async resendSignUpConfirmation(@Arg('tokenId') tokenId: string) {
    if (!tokenId) {
      throw new BadRequestError();
    }

    const token = await Token.findOne({ id: tokenId });

    if (!token) {
      // TODO If there is no token and there is no user also
      // this account was deleted due to email not being
      // confirmed for 30 days
      throw new BadRequestError();
    }

    const { token: jwtToken } = token;

    const payload = verifyToken(jwtToken, {
      ignoreExpiration: true
    });

    const { userId: id } = payload;

    const user = await User.findOne({ id, status: AccountStatus.Registered });

    if (!user) {
      // TODO If there is no token and there is no user also
      // this account was deleted due to email not being
      // confirmed for 30 days
      throw new BadRequestError();
    }

    const { email } = user;

    const newToken = createToken(CONFIRM_SIGN_UP_TOKEN_EXP)(id);

    await getManager().update(Token, { id: tokenId }, { token: newToken });

    const redirectUrl = `${APP_URL}/sign-up-confirmation/${tokenId}`;

    try {
      await sendSignUpConfirmation({
        recipient: email,
        redirectUrl,
        user: { email }
      });
    } catch {
      throw new BadRequestError(
        'Sending confirmation failed',
        ErrorReason.SendingFailedError
      );
    }

    return true;
  }

  @Mutation(() => Boolean)
  async retrySendingConfirmation(@Arg('email') email: string) {
    const user = await User.findOne({
      email,
      status: AccountStatus.Registered
    });

    if (!user) {
      throw new BadRequestError();
    }

    const { id } = user;

    const token = await Token.findOne({
      type: TokenType.SignUpConfirmToken,
      user
    });

    if (!token) {
      throw new BadRequestError();
    }

    const { id: tokenId } = token;

    const jwtToken = createToken(CONFIRM_SIGN_UP_TOKEN_EXP)(id);

    await getManager().update(Token, { id: tokenId }, { token: jwtToken });

    const redirectUrl = `${APP_URL}/sign-up-confirmation/${tokenId}`;

    try {
      await sendSignUpConfirmation({
        recipient: email,
        redirectUrl,
        user: { email }
      });
    } catch {
      throw new BadRequestError(
        'Sending confirmation failed',
        ErrorReason.SendingFailedError
      );
    }

    return true;
  }
}

//TODO validate userId, email, password, token
